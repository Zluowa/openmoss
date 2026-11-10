// FILE: mossBuiltInAppsPresentation.ts
// Purpose: How each built-in Moss app looks in Settings › 插件 › 应用: its
//          Moss icon, localized name, one-line description, about text and
//          three "try asking" prompts. The catalog itself (ids, tool families,
//          panels) lives in @moss/shared/mossBuiltInApps.
// Layer: Web presentation model
// Exports: MossBuiltInAppView, mossBuiltInAppPresentation, mossBuiltInAppViews

import {
  MOSS_BUILT_IN_APPS,
  normalizeDisabledMossApps,
  type MossBuiltInAppId,
  type MossBuiltInAppPanel,
} from "@moss/shared/mossBuiltInApps";

import {
  CheckboxCheckedIcon,
  ClockIcon,
  FoldersIcon,
  ImageIcon,
  SlidesIcon,
  TasksIcon,
  WindowAppIcon,
  type LucideIcon,
} from "~/lib/icons";
import type { TranslationKey } from "~/localization";

export interface MossBuiltInAppPresentation {
  readonly icon: LucideIcon;
  readonly nameKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
  readonly aboutKey: TranslationKey;
  readonly promptKeys: readonly [TranslationKey, TranslationKey, TranslationKey];
}

const PRESENTATION: Record<MossBuiltInAppId, MossBuiltInAppPresentation> = {
  "moss.space": {
    icon: FoldersIcon,
    nameKey: "mossApps.space.name",
    descriptionKey: "mossApps.space.description",
    aboutKey: "mossApps.space.about",
    promptKeys: ["mossApps.space.prompt1", "mossApps.space.prompt2", "mossApps.space.prompt3"],
  },
  "moss.slides": {
    icon: SlidesIcon,
    nameKey: "mossApps.slides.name",
    descriptionKey: "mossApps.slides.description",
    aboutKey: "mossApps.slides.about",
    promptKeys: ["mossApps.slides.prompt1", "mossApps.slides.prompt2", "mossApps.slides.prompt3"],
  },
  "moss.page-apps": {
    icon: WindowAppIcon,
    nameKey: "mossApps.pageApps.name",
    descriptionKey: "mossApps.pageApps.description",
    aboutKey: "mossApps.pageApps.about",
    promptKeys: [
      "mossApps.pageApps.prompt1",
      "mossApps.pageApps.prompt2",
      "mossApps.pageApps.prompt3",
    ],
  },
  "moss.media": {
    icon: ImageIcon,
    nameKey: "mossApps.media.name",
    descriptionKey: "mossApps.media.description",
    aboutKey: "mossApps.media.about",
    promptKeys: ["mossApps.media.prompt1", "mossApps.media.prompt2", "mossApps.media.prompt3"],
  },
  "moss.automations": {
    icon: ClockIcon,
    nameKey: "mossApps.automations.name",
    descriptionKey: "mossApps.automations.description",
    aboutKey: "mossApps.automations.about",
    promptKeys: [
      "mossApps.automations.prompt1",
      "mossApps.automations.prompt2",
      "mossApps.automations.prompt3",
    ],
  },
  "moss.tasks": {
    icon: TasksIcon,
    nameKey: "mossApps.tasks.name",
    descriptionKey: "mossApps.tasks.description",
    aboutKey: "mossApps.tasks.about",
    promptKeys: ["mossApps.tasks.prompt1", "mossApps.tasks.prompt2", "mossApps.tasks.prompt3"],
  },
  "moss.todos": {
    icon: CheckboxCheckedIcon,
    nameKey: "mossApps.todos.name",
    descriptionKey: "mossApps.todos.description",
    aboutKey: "mossApps.todos.about",
    promptKeys: ["mossApps.todos.prompt1", "mossApps.todos.prompt2", "mossApps.todos.prompt3"],
  },
};

export function mossBuiltInAppPresentation(id: MossBuiltInAppId): MossBuiltInAppPresentation {
  return PRESENTATION[id];
}

/** One built-in app as the 应用 tab shows it. */
export interface MossBuiltInAppView {
  readonly id: MossBuiltInAppId;
  readonly enabled: boolean;
  readonly panel: MossBuiltInAppPanel | null;
}

/** Every built-in app in catalog order, on unless the saved list turns it off. */
export function mossBuiltInAppViews(
  disabled: ReadonlyArray<string> | undefined,
): ReadonlyArray<MossBuiltInAppView> {
  const off = normalizeDisabledMossApps(disabled);
  return MOSS_BUILT_IN_APPS.map((app) => ({
    id: app.id,
    enabled: !off.has(app.id),
    panel: app.panel,
  }));
}
