// Moss Apps and the account a person is signed in with (2026-11-18, the owner's build: signed
// in, yet the 插件 page said 「登录 Moss 后即可连接你的应用。」 and the server log said nothing).
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "../../account/Services/MossEnterpriseKeyAccount";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import { ServerConfig, type ServerConfigShape } from "../../config";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { makeMcpConnectors } from "./McpConnectors";

let baseDir = "";
beforeEach(async () => {
  baseDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-apps-account-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(baseDir, { recursive: true, force: true });
});

const signedOut = {
  phone: { configured: true, authenticated: false, session: null },
  cloud: { authenticated: false, account: null },
};

function makeService(input: {
  readonly enterprise: { readonly authenticated: boolean; readonly active: boolean };
}) {
  const secrets = new Map<string, Uint8Array>();
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
        getSession: () => Effect.succeed(signedOut.phone),
        getLocalAuthority: () => Effect.succeed({ identity: null }),
      } as never),
      Effect.provideService(MossCloudAccountService, {
        getState: () => Effect.succeed(signedOut.cloud),
      } as never),
      Effect.provideService(MossEnterpriseKeyAccount, {
        getState: () => Effect.succeed(input.enterprise),
        getActiveAuthorityCredential: () => Effect.succeed(null),
      } as never),
    ),
  );
}

it("asks a person signed in with an enterprise key only to choose an account, not to sign in", async () => {
  const service = await makeService({ enterprise: { authenticated: true, active: false } });
  expect(await Effect.runPromise(service.mossApps.status())).toEqual({
    availability: "login-account-required",
    agentAccess: false,
  });
});

it("asks for a login when nobody is signed in, and says once in the log why", async () => {
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  const service = await makeService({ enterprise: { authenticated: false, active: false } });
  for (let poll = 0; poll < 3; poll += 1) {
    expect((await Effect.runPromise(service.mossApps.status())).availability).toBe(
      "authentication-required",
    );
  }
  const lines = warnings.filter((line) => line.includes("Moss Apps account check failed"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("no-signed-in-account");
});
