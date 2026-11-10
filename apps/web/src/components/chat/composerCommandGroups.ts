// FILE: composerCommandGroups.ts
// Purpose: Decides which labelled section each composer menu row belongs to, and orders `/` rows
//   so the arrow-key order is the order the menu draws.
// Layer: Chat composer logic (pure)
// Exports: groupCommandItems, orderSlashCommandItemsByGroup

import { PROVIDER_DISPLAY_NAMES } from "@moss/contracts";

import { APP_BASE_NAME } from "../../branding";
import type { ComposerTriggerKind } from "../../composer-logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

export type ComposerCommandGroupModel = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

type ComposerCommandGroupKey = Pick<ComposerCommandGroupModel, "id" | "label">;

/**
 * `/` sections name where a command comes from: Moss's own commands, the commands the
 * thread's provider reports (Claude lists its skills here too), then provider skills.
 */
function slashCommandGroupKey(item: ComposerCommandItem): ComposerCommandGroupKey {
  switch (item.type) {
    case "slash-command":
      return { id: "app", label: APP_BASE_NAME };
    case "provider-native-command":
      return {
        id: `provider:${item.provider}`,
        label: PROVIDER_DISPLAY_NAMES[item.provider] ?? "Provider",
      };
    case "skill":
      return { id: "skills", label: "Skills" };
    default:
      // Follow-up pickers (fork target, review target, model) list one kind of row.
      return { id: "other", label: null };
  }
}

/**
 * Splits a ranked `/` list into sections. A section appears where its best row ranks and keeps
 * the ranking inside, so the top match stays first and is the row Enter runs.
 */
function groupSlashCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
): ComposerCommandGroupModel[] {
  const groups = new Map<string, ComposerCommandGroupModel>();
  for (const item of items) {
    const key = slashCommandGroupKey(item);
    const group = groups.get(key.id);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key.id, { ...key, items: [item] });
    }
  }
  return [...groups.values()];
}

/**
 * Reorders a ranked `/` list into the order the sectioned menu shows it. Menu callers move the
 * highlight through the flat list, so it must already match the drawn sections.
 */
export function orderSlashCommandItemsByGroup(
  items: ReadonlyArray<ComposerCommandItem>,
): ComposerCommandItem[] {
  return groupSlashCommandItems(items).flatMap((group) => group.items);
}

function groupMentionItems(items: ReadonlyArray<ComposerCommandItem>): ComposerCommandGroupModel[] {
  const devsReportItems = items.filter((item) => item.type === "devs-report");
  const connectorItems = items.filter((item) => item.type === "connector");
  const pluginItems = items.filter((item) => item.type === "plugin");
  const threadItems = items.filter((item) => item.type === "thread");
  const localItems = items.filter((item) => item.type === "local-root" || item.type === "path");
  const agentItems = items.filter((item) => item.type === "agent");
  const otherItems = items.filter(
    (item) =>
      item.type !== "connector" &&
      item.type !== "plugin" &&
      item.type !== "thread" &&
      item.type !== "local-root" &&
      item.type !== "path" &&
      item.type !== "agent" &&
      item.type !== "devs-report",
  );

  const groups: ComposerCommandGroupModel[] = [];
  // Always on top: a bare `@devs` must pick the report, never a fuzzy match below it.
  if (devsReportItems.length > 0) {
    groups.push({ id: "devs-report", label: null, items: devsReportItems });
  }
  if (connectorItems.length > 0) {
    groups.push({ id: "connectors", label: "Connectors", items: connectorItems });
  }
  if (pluginItems.length > 0) {
    groups.push({ id: "plugins", label: "Plugins", items: pluginItems });
  }
  if (threadItems.length > 0) {
    groups.push({ id: "chats", label: "Chats", items: threadItems });
  }
  if (localItems.length > 0) {
    groups.push({ id: "local", label: "Local", items: localItems });
  }
  if (agentItems.length > 0) {
    groups.push({ id: "subagents", label: "Subagents", items: agentItems });
  }
  if (otherItems.length > 0) {
    groups.push({ id: "other", label: null, items: otherItems });
  }
  return groups;
}

export function groupCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
): ComposerCommandGroupModel[] {
  if (triggerKind === "mention") {
    return groupMentionItems(items);
  }
  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items: [...items] }];
  }
  return groupSlashCommandItems(items);
}
