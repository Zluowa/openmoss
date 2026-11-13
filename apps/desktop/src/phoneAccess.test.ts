import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PHONE_ACCESS_PORT,
  PHONE_ACCESS_OFF,
  parsePhoneAccessPreference,
  parsePhoneAccessRequest,
  phoneAccessBackendEnv,
  phoneAccessBindHost,
  pickPhoneAccessPort,
  readPhoneAccessPreference,
  resolvePhoneAccessEndpoint,
  resolvePhoneAccessState,
  writePhoneAccessPreference,
  type PhoneAccessPreference,
} from "./phoneAccess";

const ON: PhoneAccessPreference = { version: 1, enabled: true, port: null };

const free =
  (...ports: number[]) =>
  async (port: number) =>
    ports.includes(port);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

function resolve(
  preference: PhoneAccessPreference,
  overrides: Partial<Parameters<typeof resolvePhoneAccessEndpoint>[0]> = {},
) {
  return resolvePhoneAccessEndpoint({
    preference,
    isDevelopment: false,
    canListen: async () => true,
    ...overrides,
  });
}

describe("phone access preference", () => {
  it("is off until the owner turns it on", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-phone-access-"));
    tempDirs.push(dir);
    const file = Path.join(dir, "state", "phone-access.json");
    expect(readPhoneAccessPreference(file)).toEqual(PHONE_ACCESS_OFF);

    writePhoneAccessPreference(file, { ...ON, port: 3774 });
    expect(readPhoneAccessPreference(file)).toEqual({ ...ON, port: 3774 });

    FS.writeFileSync(file, "{ not json");
    expect(readPhoneAccessPreference(file)).toEqual(PHONE_ACCESS_OFF);
  });

  it("drops anything that is not a real choice or a usable port", () => {
    expect(parsePhoneAccessPreference({ version: 1, enabled: "yes" })).toBeNull();
    expect(parsePhoneAccessPreference({ version: 2, enabled: true })).toBeNull();
    expect(parsePhoneAccessPreference({ version: 1, enabled: true, port: 80 })).toEqual(ON);
    expect(parsePhoneAccessRequest({ enabled: true, host: "0.0.0.0" })).toEqual({
      enabled: true,
    });
    expect(parsePhoneAccessRequest({ enabled: "yes" })).toBeNull();
    expect(parsePhoneAccessRequest(null)).toBeNull();
  });
});

describe("phone access port", () => {
  it("prefers 3773, then the next free port, then the one it used before", async () => {
    expect(await pickPhoneAccessPort({ remembered: null, canListen: async () => true })).toBe(
      DEFAULT_PHONE_ACCESS_PORT,
    );
    expect(await pickPhoneAccessPort({ remembered: null, canListen: free(3775, 3776) })).toBe(3775);
    expect(await pickPhoneAccessPort({ remembered: 3775, canListen: async () => true })).toBe(3775);
    expect(
      await pickPhoneAccessPort({ remembered: null, canListen: async () => false }),
    ).toBeNull();
  });
});

describe("phone access endpoint", () => {
  it("stays on loopback while the setting is off, without probing any port", async () => {
    const probed: Array<[number, string]> = [];
    const canListen = async (port: number, host: string) => {
      probed.push([port, host]);
      return true;
    };
    expect(await resolve(PHONE_ACCESS_OFF, { canListen })).toEqual({
      endpoint: { mode: "off" },
      error: null,
    });
    expect(probed).toEqual([]);
    expect(phoneAccessBindHost({ mode: "off" })).toBe("127.0.0.1");
  });

  it("never binds remotely next to a dev server, which the backend would refuse", async () => {
    expect(await resolve(ON, { isDevelopment: true })).toEqual({
      endpoint: { mode: "off" },
      error: null,
    });
  });

  it("opens the local network on a port that every interface can bind", async () => {
    const probed: Array<[number, string]> = [];
    const result = await resolve(ON, {
      canListen: async (port, host) => {
        probed.push([port, host]);
        return port === 3774;
      },
    });
    expect(result).toEqual({ endpoint: { mode: "lan", port: 3774 }, error: null });
    expect(probed).toEqual([
      [3773, "0.0.0.0"],
      [3774, "0.0.0.0"],
    ]);
  });

  it("stays private and says so when no port is free", async () => {
    expect(await resolve(ON, { canListen: async () => false })).toEqual({
      endpoint: { mode: "off" },
      error: "port-unavailable",
    });
  });
});

describe("phone access backend environment", () => {
  it("adds nothing to the backend environment while off", () => {
    const inherited = { MOSS_PORT: "4100", MOSS_DESKTOP_PHONE_ACCESS: "1" };
    const env = { ...inherited, ...phoneAccessBackendEnv({ mode: "off" }) };
    expect(env).toEqual({ MOSS_PORT: "4100", MOSS_DESKTOP_PHONE_ACCESS: undefined });
    // Node leaves undefined values out of a child's environment.
    expect(Object.entries(env).filter(([, value]) => value !== undefined)).toEqual([
      ["MOSS_PORT", "4100"],
    ]);
  });

  it("binds every interface and accepts plain HTTP for the local network", () => {
    expect(phoneAccessBindHost({ mode: "lan", port: 3773 })).toBe("0.0.0.0");
    expect({
      MOSS_PUBLIC_URL: "https://elsewhere.example",
      ...phoneAccessBackendEnv({ mode: "lan", port: 3773 }),
    }).toEqual({
      MOSS_HOST: "0.0.0.0",
      MOSS_ALLOW_INSECURE_REMOTE: "1",
      MOSS_DESKTOP_PHONE_ACCESS: "1",
      MOSS_PUBLIC_URL: undefined,
    });
  });
});

describe("phone access state", () => {
  it("shows the choice next to what is really running", () => {
    expect(
      resolvePhoneAccessState({
        preference: ON,
        endpoint: { mode: "off" },
        error: "port-unavailable",
        isDevelopment: false,
      }),
    ).toEqual({
      enabled: true,
      active: "off",
      unavailableReason: null,
      error: "port-unavailable",
    });
  });

  it("explains that a development build cannot be reached from a phone", () => {
    expect(
      resolvePhoneAccessState({
        preference: ON,
        endpoint: { mode: "off" },
        error: null,
        isDevelopment: true,
      }).unavailableReason,
    ).toBe("development");
  });
});
