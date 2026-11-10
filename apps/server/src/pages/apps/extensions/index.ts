// FILE: index.ts
// Purpose: What the reaching-out 应用页 capabilities (mcp, files, assets,
// room, comments) need from the rest of the server, built once per server,
// and the list of their server halves for the capability registry.
// Layer: Server pages/apps extensions

import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../../config";
import { McpConnectors } from "../../../mcpConnectors/Services/McpConnectors";
import { makeAssetsCapability } from "../capabilities/assets";
import { makeCommentsCapability } from "../capabilities/comments";
import {
  makeFilesCapability,
  makeProjectResolver,
  type PageAppFilesDeps,
} from "../capabilities/files";
import { makeMcpCapability } from "../capabilities/mcp";
import { makeRoomCapability } from "../capabilities/room";
import type { PageAppServerCapability } from "../capabilities/types";
import { makeManagedPolicyReader, type PageAppMcpManagedPolicy } from "./mcpPolicy";
import { makePageAppMcpSources, type PageAppMcpSources } from "./mcpSources";
import { makePageAppExtensionStore, type PageAppExtensionStore } from "./PageAppExtensionStore";

export interface PageAppExtensionDeps {
  readonly store: PageAppExtensionStore;
  readonly sources: PageAppMcpSources;
  readonly policy: () => Promise<PageAppMcpManagedPolicy>;
  readonly project: PageAppFilesDeps["project"];
  readonly now: () => string;
  readonly clock?: () => number;
}

/** Builds the deps from the server's database, config and connectors (when present). */
export const makePageAppExtensionDeps = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const connectors = yield* Effect.serviceOption(McpConnectors);
  const sources = makePageAppMcpSources({
    connectors: Option.getOrNull(connectors),
    baseDir: config.baseDir,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => sources.dispose()));
  const deps: PageAppExtensionDeps = {
    store: makePageAppExtensionStore(sql),
    sources,
    policy: makeManagedPolicyReader(config.baseDir),
    project: makeProjectResolver(sql),
    now: () => new Date().toISOString(),
  };
  return deps;
});

/** Server halves of mcp, files, assets, room and comments; none without deps. */
export function makePageAppExtensionCapabilities(
  deps: PageAppExtensionDeps | null | undefined,
): ReadonlyArray<PageAppServerCapability> {
  if (!deps) return [];
  return [
    makeMcpCapability(deps),
    makeFilesCapability(deps),
    makeAssetsCapability(deps),
    makeRoomCapability(deps),
    makeCommentsCapability(deps),
  ];
}
