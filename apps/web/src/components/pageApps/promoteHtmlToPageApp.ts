// FILE: promoteHtmlToPageApp.ts
// Purpose: Turn an HTML page an agent showed in chat into an 应用页 kept in
// the 资料空间. Callers that know where the user is pass the space; declared
// capabilities, when given, win over the page's own manifest (which the
// server reads when they are left out).
// Layer: Web pageApps

import type { PageApp, PageAppCapabilities, PageSpaceId, SpaceId, ThreadId } from "@moss/contracts";

import { pageAppsClient } from "./pageAppsClient";

export async function promoteHtmlToPageApp(input: {
  readonly html: string;
  readonly title: string;
  readonly threadId: string | null;
  /** Authorization domain; null (the default) is the local default domain. */
  readonly scopeSpaceId?: SpaceId | null;
  /** Document space to file it in; null or omitted is 个人. */
  readonly spaceId?: PageSpaceId | null;
  readonly capabilities?: PageAppCapabilities;
}): Promise<PageApp> {
  const title = input.title.trim().slice(0, 256);
  const result = await pageAppsClient.mutate({
    op: "create",
    requestId: crypto.randomUUID(),
    scopeSpaceId: input.scopeSpaceId ?? null,
    html: input.html,
    ...(title ? { title } : {}),
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    sourceThreadId: (input.threadId as ThreadId | null) ?? null,
  });
  return result.app;
}
