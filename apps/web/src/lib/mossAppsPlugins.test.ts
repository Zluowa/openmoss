import type { MossAppConnection, MossAppToolkit } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  MOSS_APPS_MARKETPLACE_NAME,
  activeMossAppConnection,
  isMossAppPlugin,
  mossAppDirectoryCategory,
  mossAppDirectoryEntries,
  mossAppPluginDescriptor,
  mossAppPluginDetail,
  mossAppPluginId,
  mossAppSlugFromPluginId,
} from "./mossAppsPlugins";

function toolkit(overrides: Partial<MossAppToolkit> & Pick<MossAppToolkit, "slug" | "name">) {
  return {
    description: `${overrides.name} for agents`,
    logoUrl: `https://logos.example/${overrides.slug}.png`,
    categories: ["productivity"],
    toolsCount: 12,
    signIn: "managed",
    ...overrides,
  } satisfies MossAppToolkit;
}

function connection(
  toolkitSlug: string,
  status: MossAppConnection["status"],
  createdAt: string,
  connectionId = `ca_${toolkitSlug}_${createdAt}`,
): MossAppConnection {
  return { connectionId, toolkitSlug, status, createdAt };
}

describe("Moss Apps as plugins", () => {
  it("round-trips an app's plugin id inside the Moss Apps marketplace", () => {
    const id = mossAppPluginId("googletasks");
    expect(id).toBe(`googletasks@${MOSS_APPS_MARKETPLACE_NAME}`);
    expect(mossAppSlugFromPluginId(id)).toBe("googletasks");
    expect(isMossAppPlugin({ id })).toBe(true);
    expect(mossAppSlugFromPluginId("github@openai-curated")).toBeNull();
    expect(isMossAppPlugin({ id: "github@openai-curated" })).toBe(false);
  });

  it("files an app under the first remote-catalog category its categories map to", () => {
    expect(mossAppDirectoryCategory({ categories: ["Unknown", "Developer Tools"] })).toBe(
      "Developer Tools",
    );
    expect(mossAppDirectoryCategory({ categories: ["Sales & CRM"] })).toBe("Business & Operations");
    expect(mossAppDirectoryCategory({ categories: ["Team Chat"] })).toBe("Communication");
    expect(mossAppDirectoryCategory({ categories: ["Accounting"] })).toBe("Finance");
    expect(mossAppDirectoryCategory({ categories: ["Places & Weather"] })).toBe("Travel");
    expect(mossAppDirectoryCategory({ categories: [] })).toBe("Other");
  });

  it("treats the latest active connection as the installed one", () => {
    const connections = [
      connection("slack", "active", "2026-10-01T00:00:00.000Z", "old"),
      connection("slack", "active", "2026-10-20T00:00:00.000Z", "new"),
      connection("slack", "pending", "2026-10-25T00:00:00.000Z", "pending"),
      connection("gmail", "active", "2026-10-26T00:00:00.000Z", "other"),
    ];
    expect(activeMossAppConnection(connections, "slack")?.connectionId).toBe("new");
    expect(activeMossAppConnection(connections, "notion")).toBeNull();
  });

  it("describes an app as a Moss plugin whose install state follows its connection", () => {
    const app = toolkit({ slug: "linear", name: "Linear", categories: ["project-management"] });
    const idle = mossAppPluginDescriptor(app, null);
    expect(idle).toMatchObject({
      id: "linear@moss-apps",
      installed: false,
      enabled: false,
      installPolicy: "AVAILABLE",
      authPolicy: "ON_INSTALL",
      interface: {
        displayName: "Linear",
        developerName: "Moss",
        category: "Productivity",
        logoUrl: "https://logos.example/linear.png",
      },
    });
    const connected = mossAppPluginDescriptor(
      app,
      connection("linear", "active", "2026-10-28T00:00:00.000Z"),
    );
    expect(connected.installed).toBe(true);
    expect(connected.enabled).toBe(true);

    const detail = mossAppPluginDetail(app, null);
    expect(detail.marketplaceName).toBe(MOSS_APPS_MARKETPLACE_NAME);
    expect(detail.apps).toEqual([
      {
        id: "linear",
        name: "Linear",
        description: "Linear for agents",
        installUrl: "moss-apps:linear",
        category: "Productivity",
      },
    ]);
    expect(detail.skills).toEqual([]);
    expect(detail.mcpServers).toEqual([]);
  });

  it("lists the whole catalog as Moss Apps, connected apps first", () => {
    const entries = mossAppDirectoryEntries({
      toolkits: [
        toolkit({ slug: "googletasks", name: "Google Tasks" }),
        toolkit({ slug: "perplexityai", name: "Perplexity", signIn: "credentials" }),
        toolkit({ slug: "zendesk", name: "Zendesk", signIn: "setup" }),
        toolkit({ slug: "weather", name: "Weather", signIn: "none" }),
        toolkit({ slug: "google_calendar", name: "Google Calendar" }),
      ],
      connections: [connection("google_calendar", "active", "2026-10-28T00:00:00.000Z")],
    });
    // Every app is listed, whatever its sign-in; the connected one leads.
    expect(entries.map((entry) => entry.plugin.id)).toEqual([
      "google_calendar@moss-apps",
      "googletasks@moss-apps",
      "perplexityai@moss-apps",
      "zendesk@moss-apps",
      "weather@moss-apps",
    ]);
    expect(entries[0]?.plugin.installed).toBe(true);
    expect(entries[1]).toMatchObject({
      marketplaceName: MOSS_APPS_MARKETPLACE_NAME,
      marketplaceDisplayName: "Moss Apps",
      remoteMarketplaceName: MOSS_APPS_MARKETPLACE_NAME,
      bucket: "moss",
      provenance: "moss-apps",
      createdByYou: false,
      sharedWithYou: false,
    });
  });
});
