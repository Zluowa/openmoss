// FILE: automationDisplayName.ts
// Purpose: The name a person sees for an automation, localizing the event automation Moss
//          creates for every Hub and Mossbot assistant.
// Layer: Web presentation helper
// Exports: automationDisplayName

import type { AutomationDefinition } from "@moss/contracts";

const MANAGED_EVENT_SUFFIX = " events";

/**
 * A Hub or assistant gets one project-event automation named `${name} events`. Older servers
 * always named it in English, so in Chinese it reads "<name> · 项目事件". Names a person typed
 * (any other schedule, or any other shape) are shown as they are.
 */
export function automationDisplayName(
  definition: Pick<AutomationDefinition, "name" | "schedule">,
  locale: string,
): string {
  const { name } = definition;
  if (
    locale !== "zh-CN" ||
    definition.schedule.type !== "project-event" ||
    !name.endsWith(MANAGED_EVENT_SUFFIX)
  ) {
    return name;
  }
  const owner = name.slice(0, -MANAGED_EVENT_SUFFIX.length).trim();
  return owner ? `${owner} · 项目事件` : "项目事件";
}
