// One service plugin install must bring its skill to every CLI, and only for phone accounts.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { ServerConfig, type ServerConfigShape } from "../../config";
import { makeMcpConnectors } from "./McpConnectors";

let baseDir: string;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-service-plugins-"));
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

function makeService(phoneSignedIn: () => boolean, secrets: Map<string, Uint8Array> = new Map()) {
  return Effect.runPromise(
    makeMcpConnectors({ enabled: true }).pipe(
      Effect.provideService(ServerSecretStore, {
        get: (name: string) => Effect.succeed(secrets.get(name) ?? null),
        set: (name: string, value: Uint8Array) => Effect.sync(() => void secrets.set(name, value)),
        remove: (name: string) => Effect.sync(() => void secrets.delete(name)),
        getOrCreateRandom: () => Effect.die("unused"),
      } as never),
      Effect.provideService(AgentGatewayCredentials, {
        mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
        setConnectorServers: () => undefined,
      } as unknown as AgentGatewayCredentialsShape),
      Effect.provideService(ServerConfig, { baseDir } as ServerConfigShape),
      Effect.provideService(MossPhoneAccountService, {
        getLocalAuthority: () =>
          Effect.sync(() =>
            phoneSignedIn() ? { identity: { realm: "memfire-phone" } } : { identity: null },
          ),
      } as never),
    ),
  );
}

const skillPath = (name: string) => nodePath.join(baseDir, "skills", name, "SKILL.md");
const skillFile = (name: string) => fs.readFile(skillPath(name), "utf8").catch(() => null);

const amapConnector = (status: "connected" | "needs-auth") => ({
  connectorId: "mcp_conn_amap",
  presetId: "amap",
  name: "高德地图",
  url: "https://mcp.amap.com/mcp",
  serverName: "amap_connector",
  authKind: "api-key",
  status,
  createdAt: "2026-11-02T08:00:00.000Z",
  updatedAt: "2026-11-02T08:00:00.000Z",
  oauth: null,
  apiKey: { kind: "query", param: "key", value: "k" },
});

const savedConnectors = (...connectors: ReadonlyArray<unknown>) =>
  new Map([
    ["mcp-connectors", new TextEncoder().encode(JSON.stringify({ version: 1, connectors }))],
  ]);

it("leaves the legacy anonymous Apps owner and other connector records untouched", async () => {
  const legacy = new TextEncoder().encode("moss_legacy_anonymous_fixture");
  const secrets = new Map([["moss-apps-user", legacy]]);
  const service = await makeService(() => false, secrets);
  await Effect.runPromise(service.servicePlugins.resync());
  expect(secrets.get("moss-apps-user")).toBe(legacy);
  expect(await Effect.runPromise(service.mossApps.status())).toEqual({
    availability: "authentication-required",
    agentAccess: false,
  });
});

it("installs a skill-only plugin's skill into the shared folder and removes it again", async () => {
  const service = await makeService(() => true);
  expect(await Effect.runPromise(service.servicePlugins.list())).toEqual({
    installed: [],
    skills: [],
  });

  const installed = await Effect.runPromise(
    service.servicePlugins.setInstalled({ pluginId: "taobao", installed: true }),
  );
  // The real path lets "Try in chat" attach the skill for every CLI.
  expect(installed).toEqual({
    installed: ["taobao"],
    skills: [{ pluginId: "taobao", name: "taobao-shopping", path: skillPath("taobao-shopping") }],
  });
  expect(await skillFile("taobao-shopping")).toContain("name: taobao-shopping");

  const removed = await Effect.runPromise(
    service.servicePlugins.setInstalled({ pluginId: "taobao", installed: false }),
  );
  expect(removed).toEqual({ installed: [], skills: [] });
  expect(await skillFile("taobao-shopping")).toBeNull();
});

it("refuses without a phone sign-in, and leaves MCP plugins to the connector flow", async () => {
  const service = await makeService(() => false);
  await expect(
    Effect.runPromise(service.servicePlugins.setInstalled({ pluginId: "flyai", installed: true })),
  ).rejects.toThrow("mainland China phone number");
  await expect(
    Effect.runPromise(service.servicePlugins.setInstalled({ pluginId: "amap", installed: true })),
  ).rejects.toThrow("Connect this plugin's service");
  await expect(
    Effect.runPromise(service.servicePlugins.setInstalled({ pluginId: "luckin", installed: true })),
  ).rejects.toThrow("This plugin is not available.");
  expect(await skillFile("flyai-travel")).toBeNull();
});

it("writes an MCP plugin's skill once its connector is there, on restore too", async () => {
  const service = await makeService(() => true, savedConnectors(amapConnector("connected")));
  expect(await Effect.runPromise(service.servicePlugins.list())).toMatchObject({
    installed: ["amap"],
  });
  expect(await skillFile("amap-maps")).toContain("amap_connector");

  await Effect.runPromise(service.disconnect("mcp_conn_amap"));
  // The skill follows the connector out.
  await expect.poll(() => skillFile("amap-maps")).toBeNull();
  expect(await Effect.runPromise(service.servicePlugins.list())).toEqual({
    installed: [],
    skills: [],
  });
});

it("shows a connector with a rejected key or expired sign-in as needing a reconnect", async () => {
  const service = await makeService(() => true, savedConnectors(amapConnector("needs-auth")));
  // Not installed, so the plugin page offers to connect it again.
  expect(await Effect.runPromise(service.servicePlugins.list())).toEqual({
    installed: [],
    skills: [],
  });
  expect(await skillFile("amap-maps")).toBeNull();
});

it("keeps skill-only skills out while no phone account is signed in, and back after", async () => {
  let phone = true;
  const service = await makeService(() => phone);
  await Effect.runPromise(
    service.servicePlugins.setInstalled({ pluginId: "taobao", installed: true }),
  );
  expect(await skillFile("taobao-shopping")).not.toBeNull();

  // Signing out: reading the list (or the account hook) takes the skill out.
  phone = false;
  expect(await Effect.runPromise(service.servicePlugins.list())).toEqual({
    installed: ["taobao"],
    skills: [],
  });
  expect(await skillFile("taobao-shopping")).toBeNull();

  // Signing back in brings it back without reinstalling.
  phone = true;
  await Effect.runPromise(service.servicePlugins.resync());
  expect(await skillFile("taobao-shopping")).toContain("name: taobao-shopping");
});

it("keeps both of two quick installs", async () => {
  const secrets = new Map<string, Uint8Array>();
  const service = await makeService(() => true, secrets);
  await Promise.all([
    Effect.runPromise(service.servicePlugins.setInstalled({ pluginId: "taobao", installed: true })),
    Effect.runPromise(service.servicePlugins.setInstalled({ pluginId: "flyai", installed: true })),
  ]);
  const state = await Effect.runPromise(service.servicePlugins.list());
  expect(state.installed.toSorted()).toEqual(["flyai", "taobao"]);
  const saved = JSON.parse(new TextDecoder().decode(secrets.get("moss-service-plugins")!)) as {
    installed: string[];
  };
  expect(saved.installed.toSorted()).toEqual(["flyai", "taobao"]);
  expect(await skillFile("flyai-travel")).not.toBeNull();
  expect(await skillFile("taobao-shopping")).not.toBeNull();
});
