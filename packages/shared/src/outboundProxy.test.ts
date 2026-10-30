import { describe, expect, it } from "vitest";

import {
  applyOutboundProxyEnv,
  createCachedSystemProxyReader,
  hasOutboundProxy,
  parseMacOsScutilProxy,
  withOutboundProxyEnv,
} from "./outboundProxy";

const SCUTIL_HTTP_HTTPS = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
}
`;

describe("parseMacOsScutilProxy", () => {
  it("maps enabled HTTP(S) system proxy to CLI env vars", () => {
    const env = parseMacOsScutilProxy(SCUTIL_HTTP_HTTPS);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.https_proxy).toBe("http://127.0.0.1:7897");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.NO_PROXY).toContain("*.local");
    expect(env.NO_PROXY).toContain("169.254/16");
  });

  it("uses SOCKS only when HTTP(S) is off", () => {
    const env = parseMacOsScutilProxy(`
      HTTPEnable : 0
      HTTPSEnable : 0
      SOCKSEnable : 1
      SOCKSProxy : 127.0.0.1
      SOCKSPort : 1080
    `);
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("ignores a disabled or PAC-only configuration", () => {
    expect(
      parseMacOsScutilProxy(`
        HTTPEnable : 0
        HTTPSEnable : 0
        ProxyAutoConfigEnable : 1
        ProxyAutoConfigURLString : http://wpad.example/proxy.pac
      `),
    ).toEqual({});
  });
});

describe("withOutboundProxyEnv", () => {
  it("keeps an already configured HTTPS proxy", () => {
    const env = { HTTPS_PROXY: "http://proxy.example:8080", PATH: "/usr/bin" };
    expect(
      withOutboundProxyEnv(env, { readSystemProxy: () => ({ HTTPS_PROXY: "http://other" }) }),
    ).toBe(env);
  });

  it("fills a missing proxy from the system reader", () => {
    const env = withOutboundProxyEnv(
      { PATH: "/usr/bin" },
      { platform: "linux", readSystemProxy: () => ({ HTTPS_PROXY: "http://127.0.0.1:7897" }) },
    );
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("applyOutboundProxyEnv", () => {
  it("mutates the target only when a proxy is missing", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyOutboundProxyEnv(env, {
      platform: "darwin",
      readSystemProxy: () => ({ HTTPS_PROXY: "http://127.0.0.1:7897" }),
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(hasOutboundProxy(env)).toBe(true);
  });
});

describe("createCachedSystemProxyReader", () => {
  it("reads the system proxy once per TTL", () => {
    let reads = 0;
    let clock = 0;
    const read = createCachedSystemProxyReader(
      () => {
        reads += 1;
        return {};
      },
      { ttlMs: 1_000, now: () => clock },
    );

    read();
    clock = 999;
    read();
    expect(reads).toBe(1);

    clock = 1_000;
    read();
    expect(reads).toBe(2);
  });
});
