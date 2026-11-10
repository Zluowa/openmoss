// FILE: index.ts
// Purpose: Registry of the server halves of 应用页 capabilities. Add a
// capability with one line in `makePageAppServerCapabilities`.
// Layer: Server pages/apps

import type { PageAppAiGateway } from "../aiGateway";
import type { PageAppDbStore } from "../PageAppDbStore";
import { makePageAppExtensionCapabilities, type PageAppExtensionDeps } from "../extensions";
import { makeAiCapability } from "./ai";
import { makeDbCapability } from "./db";
import { makePageCapability, type PageAppRepublish } from "./page";
import type { PageAppServerCapability } from "./types";

/** What server capability halves may depend on. Extend with new fields as needed. */
export interface PageAppServerDeps {
  readonly db: PageAppDbStore;
  readonly ai: PageAppAiGateway;
  readonly now: () => string;
  readonly republish: PageAppRepublish;
  /** mcp, files, assets, room and comments; null serves none of them. */
  readonly extensions: PageAppExtensionDeps | null;
}

export function makePageAppServerCapabilities(
  deps: PageAppServerDeps,
): ReadonlyArray<PageAppServerCapability> {
  return [
    makeDbCapability(deps),
    makeAiCapability(deps),
    makePageCapability(deps),
    ...makePageAppExtensionCapabilities(deps.extensions),
  ];
}
