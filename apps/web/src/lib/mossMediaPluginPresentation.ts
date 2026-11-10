// FILE: mossMediaPluginPresentation.ts
// Purpose: Shows Moss's own image, video and Canvas plugins and their skills in the
//          person's UI language. Their manifests are English; plugin rows and skill
//          lists render descriptions as third-party text the page never translates,
//          so the copy is swapped where plugin and skill listings enter the renderer.
// Layer: Web presentation helper (pure).

import type {
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderPluginDescriptor,
  ProviderReadPluginResult,
  ProviderSkillDescriptor,
} from "@moss/contracts";
import {
  MOSS_CANVAS_SKILL_DESCRIPTION,
  mossMediaPlugin,
  mossMediaSkillDescription,
} from "@moss/shared/mossMediaPlugins";

import type { MossLocaleCode } from "~/uiLocale";

const MOSS_BUNDLED_MARKETPLACE = "moss-bundled";

function isMossBundledPlugin(plugin: ProviderPluginDescriptor): boolean {
  return plugin.id === `${plugin.name}@${MOSS_BUNDLED_MARKETPLACE}`;
}

export function localizeMossMediaPlugin(
  plugin: ProviderPluginDescriptor,
  locale: MossLocaleCode,
): ProviderPluginDescriptor {
  if (locale !== "zh-CN" || !plugin.interface || !isMossBundledPlugin(plugin)) return plugin;
  const spec = mossMediaPlugin(plugin.name);
  if (!spec) return plugin;
  return {
    ...plugin,
    interface: {
      ...plugin.interface,
      displayName: spec.zhCN.displayName,
      shortDescription: spec.zhCN.shortDescription,
      longDescription: spec.zhCN.longDescription,
      defaultPrompt: [spec.zhCN.defaultPrompt],
    },
  };
}

/** A Moss media skill as Codex lists it: `moss-imagegen` or `moss-imagegen:moss-imagegen`. */
export function localizeMossMediaSkill(
  skill: ProviderSkillDescriptor,
  locale: MossLocaleCode,
): ProviderSkillDescriptor {
  if (locale !== "zh-CN") return skill;
  const [pluginName = "", skillName = pluginName] = skill.name.split(":");
  const spec = pluginName === skillName ? mossMediaPlugin(pluginName) : undefined;
  // Only the copy Moss wrote from its own marketplace, never a same-named user skill.
  if (!spec || !skill.path.replaceAll("\\", "/").includes(MOSS_BUNDLED_MARKETPLACE)) return skill;
  return {
    ...skill,
    description:
      spec.kind === "canvas"
        ? MOSS_CANVAS_SKILL_DESCRIPTION.zhCN
        : mossMediaSkillDescription(spec, "zhCN"),
    interface: {
      ...skill.interface,
      displayName: spec.zhCN.displayName,
      shortDescription: spec.zhCN.shortDescription,
    },
  };
}

export function localizeMossMediaPluginsResult(
  result: ProviderListPluginsResult,
  locale: MossLocaleCode,
): ProviderListPluginsResult {
  if (locale !== "zh-CN") return result;
  return {
    ...result,
    marketplaces: result.marketplaces.map((marketplace) =>
      marketplace.name === MOSS_BUNDLED_MARKETPLACE
        ? {
            ...marketplace,
            plugins: marketplace.plugins.map((plugin) => localizeMossMediaPlugin(plugin, locale)),
          }
        : marketplace,
    ),
  };
}

export function localizeMossMediaPluginDetail(
  result: ProviderReadPluginResult,
  locale: MossLocaleCode,
): ProviderReadPluginResult {
  if (locale !== "zh-CN" || result.plugin.marketplaceName !== MOSS_BUNDLED_MARKETPLACE)
    return result;
  const summary = localizeMossMediaPlugin(result.plugin.summary, locale);
  return {
    ...result,
    plugin: {
      ...result.plugin,
      summary,
      description: summary.interface?.longDescription ?? result.plugin.description,
      skills: result.plugin.skills.map((skill) => localizeMossMediaSkill(skill, locale)),
    },
  };
}

export function localizeMossMediaSkillsResult(
  result: ProviderListSkillsResult,
  locale: MossLocaleCode,
): ProviderListSkillsResult {
  if (locale !== "zh-CN") return result;
  return { ...result, skills: result.skills.map((skill) => localizeMossMediaSkill(skill, locale)) };
}
