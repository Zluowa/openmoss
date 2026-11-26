// FILE: index.ts
// Purpose: Registry of the server halves of 应用页 capabilities. Add a
// capability with one line in `makePageAppServerCapabilities`.
// Layer: Server pages/apps

import type { PageAppAiGateway } from "../aiGateway";
import type { PageAppDbStore } from "../PageAppDbStore";
import { makePageAppExtensionCapabilities, type PageAppExtensionDeps } from "../extensions";
import { makeAiCapability } from "./ai";
import { makeChatCapability } from "./chat";
import { makeDbCapability } from "./db";
import { makeMediaCapability, type PageAppMediaGateway } from "./media";
import { makeMossbotCapability, type PageAppMossbotGateway } from "./mossbot";
import { makePageCapability, type PageAppRepublish } from "./page";
import type { PageAppServerCapability } from "./types";
import { makeVoiceCapability, type PageAppVoiceGateway } from "./voice";

/** What server capability halves may depend on. Extend with new fields as needed. */
export interface PageAppServerDeps {
  readonly db: PageAppDbStore;
  readonly ai: PageAppAiGateway;
  readonly now: () => string;
  readonly republish: PageAppRepublish;
  /** mcp, files, assets, room and comments; null serves none of them. */
  readonly extensions: PageAppExtensionDeps | null;
  readonly media?: PageAppMediaGateway | null;
  readonly mossbot?: PageAppMossbotGateway | null;
  readonly voice?: PageAppVoiceGateway | null;
}

export function makePageAppServerCapabilities(
  deps: PageAppServerDeps,
): ReadonlyArray<PageAppServerCapability> {
  return [
    makeDbCapability(deps),
    makeAiCapability(deps),
    makeChatCapability(deps),
    makeMediaCapability(deps),
    makeMossbotCapability(deps),
    makeVoiceCapability(deps),
    makePageCapability(deps),
    ...makePageAppExtensionCapabilities(deps.extensions),
  ];
}
