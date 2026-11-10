import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { ProviderPluginDetail, ProviderSkillDescriptor } from "@moss/contracts";
import { readRegularFileNoFollow } from "../workspaceImport/safeFile";
import { MOSS_BUNDLED_MEDIA_PLUGINS, buildMossBundledMediaSkill } from "./mossBundledMediaPlugins";
import { assertMossManagedPluginHome } from "./mossBundledPluginBootstrap";
import {
  MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
  mossBundledPluginMarketplaceRoot,
} from "./mossBundledPluginMarketplace";
import { withManagedPluginConfigLock } from "./mossManagedPluginConfig";

// Exact shipped bytes from 1.0.4 and the subsequent preview. Never upgrade an unknown edit.
const previousHashes: Record<string, readonly string[]> = {
  "moss-imagegen": [
    "a1d4e106d98d2c5af0ddf212e73bfbf925b9cce39f3797f8687d207b7a0255d1",
    "8c91b1b81747893ef553b75c8ba81cec52d3015f3ba832f9f6b3735d4c43a2b8",
  ],
  "moss-gpt-image": [
    "e68d1fbf3cec7116c864a4ed685a950bb1d3ad9cb02bf3e75df1e25087d68608",
    "b98c6bf371dce28faaf6c329e565f63608bb7286f547b1ac01e0b1fa5b190b3f",
  ],
  "moss-seedream": [
    "a1945dc3087dd0d866d4e216edfee08bf3c35369f8fb0742463aaff9f13acf60",
    "6263b8b579d1c70a47c0bb73a60ae89efece55d97b1e7a2875ed9b3f30cc9f5c",
  ],
  "moss-nano-banana": [
    "11001f226def0dc9f3a643fa3842d2a19656c40b7926d1979e9200152200f283",
    "798141cd77e15effb06189b1abc657d4d98c36270c5bad0a281a41c33845db36",
  ],
  "moss-grok-image": [
    "6660c837af48f523abaaa3a0a41df0b8d9c74ceef0e71067bdca50e3551c9885",
    "bd0cd8c4a752bc19f855c41af30d5fbb0c5fa9676b3a4c468963804cb8a4e017",
  ],
  "moss-wan-image": [
    "b16f50da59fb941e4156d81fd114f2e010160290d61be46442cc2e66fc639615",
    "5fc18bbb9b2a111fa3e9adcd6ea535d00a0ee60c1b34f81304fb167263fa6b25",
  ],
};

const maxBytes = 64 * 1024;
const samePath = (left: string, right: string) => path.relative(left, right) === "";

async function regularBytes(file: string) {
  if (!samePath(await realpath(file), file)) return;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) return;
  return readRegularFileNoFollow(file, maxBytes);
}

type InstalledImagePlugin = Pick<ProviderPluginDetail, "marketplaceName" | "marketplacePath"> & {
  summary: Pick<
    ProviderPluginDetail["summary"],
    "name" | "id" | "source" | "localVersion" | "installed" | "enabled" | "availability"
  >;
};
export interface ManagedImageSkillUpgradeInput {
  managedHomePath: string;
  runtimeHomePath: string;
  readPlugin: (selector: {
    marketplacePath: string;
    pluginName: string;
  }) => Promise<InstalledImagePlugin>;
  listSkills: () => Promise<readonly Pick<ProviderSkillDescriptor, "name" | "path" | "enabled">[]>;
  assertCurrent: () => void;
}

/** Replace only already installed, enabled, unmodified copies. Native install and config are untouched. */
export async function upgradeManagedImageSkills(
  input: ManagedImageSkillUpgradeInput,
): Promise<boolean> {
  const home = await assertMossManagedPluginHome(input.managedHomePath);
  const market = mossBundledPluginMarketplaceRoot(home);
  const marketplacePath = path.join(market, ".agents", "plugins", "marketplace.json");
  return withManagedPluginConfigLock(home, async () => {
    input.assertCurrent();
    let changed = false;
    for (const plugin of MOSS_BUNDLED_MEDIA_PLUGINS) {
      const hashes = previousHashes[plugin.name];
      if (plugin.kind !== "image" || !hashes) continue;
      const name = plugin.name;
      const relative = path.join(
        "plugins",
        "cache",
        MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
        name,
        "1.1.0",
        "skills",
        name,
        "SKILL.md",
      );
      const target = path.join(home, relative);
      try {
        const prior = await regularBytes(target);
        if (!prior || !hashes.includes(createHash("sha256").update(prior).digest("hex"))) continue;
        const source = path.join(market, "plugins", name);
        const content = Buffer.from(buildMossBundledMediaSkill(plugin));
        if (!(await regularBytes(path.join(source, "skills", name, "SKILL.md")))?.equals(content))
          continue;
        const detail = await input.readPlugin({ marketplacePath, pluginName: name });
        const { summary } = detail;
        if (
          detail.marketplaceName !== MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME ||
          !detail.marketplacePath ||
          !samePath(detail.marketplacePath, marketplacePath) ||
          summary.name !== name ||
          summary.id !== `${name}@${MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME}` ||
          summary.source.type !== "local" ||
          !samePath(summary.source.path, source) ||
          summary.localVersion !== "1.1.0" ||
          !summary.installed ||
          !summary.enabled ||
          summary.availability !== "AVAILABLE"
        )
          continue;
        const runtimeTarget = path.join(input.runtimeHomePath, relative);
        const skill = (await input.listSkills()).find(
          (item) =>
            item.enabled &&
            item.name === `${name}:${name}` &&
            (samePath(item.path, runtimeTarget) || samePath(item.path, target)),
        );
        if (!skill || !samePath(await realpath(skill.path), target)) continue;
        const tmp = `${target}.${randomUUID()}.tmp`;
        const handle = await open(tmp, "wx", 0o600);
        try {
          try {
            await handle.writeFile(content);
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (!(await regularBytes(target))?.equals(prior) || !samePath(await realpath(tmp), tmp))
            continue;
          input.assertCurrent();
          await rename(tmp, target);
          changed = true;
        } finally {
          await rm(tmp, { force: true });
        }
      } catch (error) {
        // A missing, read-only or locked optional skill stays intact. Retry on a later startup.
        const code = (error as NodeJS.ErrnoException).code;
        if (!["ENOENT", "ENOTDIR", "EPERM", "EACCES", "EBUSY", "EROFS"].includes(code ?? ""))
          throw error;
      }
    }
    return changed;
  });
}
