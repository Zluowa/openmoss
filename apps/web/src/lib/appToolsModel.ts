// FILE: appToolsModel.ts
// Purpose: Exact Codex Desktop Apps tools grouping, labels, URLs, and OAuth callback semantics.

import type {
  DesktopConnectorOAuthCallback,
  ProviderAppInfo,
  ProviderAppTool,
  ProviderStartAppConnectionResult,
} from "@synara/contracts";
import { MOSS_CONNECTOR_OAUTH_SCHEME } from "@synara/shared/desktopIdentity";

export const APP_CONNECTOR_OAUTH_CALLBACK_URL = `${MOSS_CONNECTOR_OAUTH_SCHEME}://connector/oauth_callback`;

export interface AppToolSection {
  readonly title: "Write" | "Read";
  readonly tools: ReadonlyArray<ProviderAppTool>;
}

export function groupAppTools(tools: ReadonlyArray<ProviderAppTool>): AppToolSection[] {
  const read = tools.filter((tool) => tool.accessBadges.includes("READ"));
  const sections: AppToolSection[] = [
    { title: "Write", tools: tools.filter((tool) => !tool.accessBadges.includes("READ")) },
    { title: "Read", tools: read },
  ];
  return sections.filter((section) => section.tools.length > 0);
}

export function appToolsSummary(
  app: Pick<ProviderAppInfo, "name">,
  sections: ReadonlyArray<AppToolSection>,
): string {
  const totalActions = sections.reduce((total, section) => total + section.tools.length, 0);
  const actionTypes = sections
    .map((section) => `${section.tools.length} ${section.title.toLowerCase()}`)
    .join(", ");
  return `The ${app.name} app contains ${totalActions} actions (${actionTypes})`;
}

export function isAppToolDisabledByAdmin(tool: ProviderAppTool): boolean {
  return tool.disabledReason === "disabled_by_admin";
}

export function buildAppComposerMention(app: Pick<ProviderAppInfo, "id" | "name">): string {
  return `[@${app.name}](app://${app.id})`;
}

export function buildAppManageUrl(
  app: Pick<ProviderAppInfo, "id" | "installUrl">,
  addConnectorLink: boolean,
): string | null {
  const source = app.installUrl?.trim();
  if (!source) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const search = new URLSearchParams([["connector", app.id]]);
  if (addConnectorLink) search.set("add-connector-link", "true");
  search.set("product-sku", "CODEX");
  search.set("referrer", "codex");
  url.hash = `settings/Connectors?${search.toString()}`;
  return url.toString();
}

interface ConnectorOAuthBridge {
  onCallback: (listener: (callback: DesktopConnectorOAuthCallback) => void) => () => void;
}

export function createConnectorOAuthCallbackSubscription(
  bridge: ConnectorOAuthBridge | undefined,
  complete: (callback: DesktopConnectorOAuthCallback) => Promise<void>,
): () => void {
  if (!bridge) return () => undefined;
  const consumed = new Set<string>();
  return bridge.onCallback((callback) => {
    if (consumed.has(callback.fullRedirectUrl)) return;
    consumed.add(callback.fullRedirectUrl);
    void complete(callback).catch(() => undefined);
  });
}

export async function resolveStartedAppConnection(input: {
  readonly result: ProviderStartAppConnectionResult;
  readonly browserFallbackUrl: string | null;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly connected: () => Promise<void>;
}): Promise<"oauth-started" | "connected-directly" | "browser-fallback" | "failed"> {
  switch (input.result.kind) {
    case "oauthStarted":
      return (await input.openExternal(input.result.redirectUrl)) ? "oauth-started" : "failed";
    case "connectedDirectly":
      await input.connected();
      return "connected-directly";
    case "browserFallback":
      if (!input.browserFallbackUrl) return "failed";
      return (await input.openExternal(input.browserFallbackUrl)) ? "browser-fallback" : "failed";
  }
}
