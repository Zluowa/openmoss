// FILE: index.ts
// Purpose: Public entrypoint for Moss UI Kit (non-invasive Shadow DOM core primitives,
//          native voice controls, feature widgets, catalog, and mount helpers).
// Layer: Shared Page App UI Kit

import { MOSS_UI_KIT_CATALOG, MOSS_UI_KIT_RECIPES } from "./catalog";
import {
  MossbotMeetingBar,
  MossCompanionDrawer,
  MossMediaTrigger,
  MossSelectionAsk,
  mountCompanionDrawer,
  mountMediaTrigger,
  mountMossbotMeetingBar,
  mountSelectionAsk,
  registerMossUIKit as registerFeatureWidgets,
} from "./components";
import {
  MossBadge,
  MossButton,
  MossCard,
  MossDialog,
  MossDrawer,
  MossMarkdown,
  MossTabs,
  MossToast,
  mountBadge,
  mountButton,
  mountCard,
  mountDialog,
  mountDrawer,
  mountMarkdown,
  mountTabs,
  registerMossPrimitives,
} from "./primitives";
import {
  MOSS_UI_KIT_CLASSIC_URLS,
  MOSS_UI_KIT_MODULE_URLS,
  MOSS_UI_KIT_TOKENS_CSS,
  MOSS_UI_KIT_VERSION,
} from "./tokens";
import {
  MossRealtimeVoiceBar,
  MossVoiceButton,
  mountRealtimeVoiceBar,
  mountVoiceButton,
  registerMossVoiceComponents,
} from "./voice";

export function registerMossUIKit(): void {
  registerMossPrimitives();
  registerMossVoiceComponents();
  registerFeatureWidgets();
}

export {
  MOSS_UI_KIT_CATALOG,
  MOSS_UI_KIT_CLASSIC_URLS,
  MOSS_UI_KIT_MODULE_URLS,
  MOSS_UI_KIT_RECIPES,
  MOSS_UI_KIT_TOKENS_CSS,
  MOSS_UI_KIT_VERSION,
  MossBadge,
  MossButton,
  MossCard,
  MossCompanionDrawer,
  MossDialog,
  MossDrawer,
  MossMarkdown,
  MossMediaTrigger,
  MossRealtimeVoiceBar,
  MossSelectionAsk,
  MossTabs,
  MossToast,
  MossVoiceButton,
  MossbotMeetingBar,
  mountBadge,
  mountButton,
  mountCard,
  mountCompanionDrawer,
  mountDialog,
  mountDrawer,
  mountMarkdown,
  mountMediaTrigger,
  mountMossbotMeetingBar,
  mountRealtimeVoiceBar,
  mountSelectionAsk,
  mountTabs,
  mountVoiceButton,
  registerMossPrimitives,
  registerMossVoiceComponents,
};

export type { MossUiKitCatalogEntry } from "./catalog";
export type {
  MossCompanionDrawerOptions,
  MossHighlightColor,
  MossHighlightDetail,
  MossMediaTriggerOptions,
  MossSelectionAskOptions,
  MossbotMeetingBarOptions,
} from "./components";
export type { MossTabItem } from "./primitives";
export type { MossRealtimeVoiceBarOptions, MossVoiceButtonOptions } from "./voice";
export type {
  MossAskOutcome,
  MossAskParams,
  MossMediaOutcome,
  MossRealtimeVoiceOutcome,
  MossVoiceSpeakOutcome,
  MossVoiceTranscriptOutcome,
  MossbotJoinOutcome,
  MossbotSummaryOutcome,
} from "./mossBridge";

registerMossUIKit();

const MossUIKit = Object.freeze({
  version: MOSS_UI_KIT_VERSION,
  tokensCss: MOSS_UI_KIT_TOKENS_CSS,
  catalog: MOSS_UI_KIT_CATALOG,
  recipes: MOSS_UI_KIT_RECIPES,
  MossButton,
  MossCard,
  MossTabs,
  MossDrawer,
  MossDialog,
  MossBadge,
  MossToast,
  MossMarkdown,
  MossVoiceButton,
  MossRealtimeVoiceBar,
  MossSelectionAsk,
  MossCompanionDrawer,
  MossbotMeetingBar,
  MossMediaTrigger,
  mountButton,
  mountCard,
  mountTabs,
  mountDrawer,
  mountDialog,
  mountBadge,
  mountMarkdown,
  mountVoiceButton,
  mountRealtimeVoiceBar,
  mountSelectionAsk,
  mountCompanionDrawer,
  mountMossbotMeetingBar,
  mountMediaTrigger,
  registerMossUIKit,
});

if (typeof globalThis !== "undefined") {
  (globalThis as { MossUIKit?: typeof MossUIKit }).MossUIKit = MossUIKit;
}

export default MossUIKit;
