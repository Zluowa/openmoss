// FILE: mossBuiltInAppPanels.ts
// Purpose: Open a built-in Moss app's own surface (its 打开 button in
//          Settings › 插件 › 应用): the 资料空间 and Images destinations, or a route.
// Layer: Web navigation helper
// Exports: openMossBuiltInAppPanel, MossBuiltInAppRoute

import type { MossBuiltInAppPanel } from "@moss/shared/mossBuiltInApps";

import { openMossCanvas, openMossLibraryDestination } from "./mossCanvasBridge";
import { closeSettings } from "../settingsDialogStore";

export type MossBuiltInAppRoute = "/apps" | "/automations" | "/tasks";

/** Settings closes first: the surface opens behind the dialog otherwise. */
export function openMossBuiltInAppPanel(
  panel: MossBuiltInAppPanel,
  navigateTo: (to: MossBuiltInAppRoute) => void,
): void {
  closeSettings();
  switch (panel) {
    case "library":
      openMossLibraryDestination();
      return;
    case "images":
      openMossCanvas({ surface: "images" });
      return;
    case "page-apps":
      navigateTo("/apps");
      return;
    case "automations":
      navigateTo("/automations");
      return;
    case "tasks":
      navigateTo("/tasks");
      return;
  }
}
