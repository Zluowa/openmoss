import { describe, expect, it } from "vitest";
import * as Path from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
  buildMossAuthProtocolClientArguments,
  buildMossAuthCallbackRendererUrl,
  isMossAuthProtocolRelayProcess,
  resolveMossAuthProtocolClientEntryPoint,
  resolveMossAuthCallbackRoute,
  resolveMossAuthCallbackRouteFromArgv,
  shouldRegisterMossAuthCallbackProtocolClient,
} from "./mossAuthDeepLink";

describe("resolveMossAuthProtocolClientEntryPoint", () => {
  it("skips the Moss Dev ownership marker and finds the real Electron main script", () => {
    expect(
      resolveMossAuthProtocolClientEntryPoint([
        "/path/to/Moss (Dev).app/Contents/MacOS/Electron",
        "--moss-dev-root=/workspace/apps/desktop",
        "dist-electron/main.js",
      ]),
    ).toBe("dist-electron/main.js");
    expect(
      resolveMossAuthProtocolClientEntryPoint([
        "/path/to/electron",
        "apps/desktop/dist-electron/main.js",
      ]),
    ).toBe("apps/desktop/dist-electron/main.js");
  });

  it("does not treat flags or callback URLs as executable entry points", () => {
    expect(
      resolveMossAuthProtocolClientEntryPoint([
        "/path/to/electron",
        "--inspect=9229",
        "moss://auth/callback?code=secret",
      ]),
    ).toBeNull();
  });
});

describe("buildMossAuthProtocolClientArguments", () => {
  it("pins isolated Dev callbacks to the running profile and relay-only process", () => {
    const entryPoint = Path.resolve("apps/desktop/dist-electron/main.js");
    const userDataPath = Path.resolve(".moss-auth-e2e/electron-userdata");

    expect(
      buildMossAuthProtocolClientArguments(
        ["/path/to/Moss (Dev).app/Contents/MacOS/Electron", entryPoint],
        userDataPath,
      ),
    ).toEqual(["--moss-auth-callback-relay", `--user-data-dir=${userDataPath}`, entryPoint]);
  });

  it("fails closed when the executable entry point or isolated profile is unsafe", () => {
    expect(
      buildMossAuthProtocolClientArguments(
        ["/path/to/electron", "moss://auth/callback?code=secret"],
        Path.resolve(".moss-auth-e2e/electron-userdata"),
      ),
    ).toBeNull();
    expect(
      buildMossAuthProtocolClientArguments(
        ["/path/to/electron", Path.resolve("apps/desktop/dist-electron/main.js")],
        "relative/profile",
      ),
    ).toBeNull();
  });
});

describe("isMossAuthProtocolRelayProcess", () => {
  it("recognizes only the exact relay marker", () => {
    expect(
      isMossAuthProtocolRelayProcess([
        "/path/to/electron",
        "--moss-auth-callback-relay",
        "moss://auth/callback?code=secret",
      ]),
    ).toBe(true);
    expect(
      isMossAuthProtocolRelayProcess(["/path/to/electron", "--moss-auth-callback-relay=1"]),
    ).toBe(false);
  });
});

describe("shouldRegisterMossAuthCallbackProtocolClient", () => {
  it.each([true, false])(
    "guards the actual registration entry point on startup and OAuth refresh (packaged=%s)",
    (isPackaged) => {
      // Exercise the production entry point without booting Electron. Its only
      // TypeScript syntax is this return annotation; the body stays unchanged.
      const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
      const entry = source.match(
        /^function registerMossAuthCallbackProtocolClient\(\): void \{[\s\S]*?^\}/m,
      )?.[0];
      expect(entry).toBeDefined();
      for (const setting of ["1", "0", undefined]) {
        const schemes: string[] = [];
        const register = runInNewContext(
          `${entry!.replace("(): void", "()")}\nregisterMossAuthCallbackProtocolClient`,
          {
            app: {
              isPackaged,
              setAsDefaultProtocolClient: (scheme: string) => (schemes.push(scheme), true),
            },
            process: {
              env: { MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: setting },
              defaultApp: true,
              argv: ["/qa/electron", Path.resolve("qa-main.js")],
              execPath: "/qa/electron",
            },
            userDataPath: Path.resolve("qa-profile"),
            DESKTOP_SCHEME: "moss",
            shouldRegisterMossAuthCallbackProtocolClient,
            buildMossAuthProtocolClientArguments,
            writeDesktopLogHeader: () => undefined,
          },
        ) as () => void;
        register();
        register();
        expect(schemes).toEqual(setting === "1" ? [] : ["moss", "moss"]);
      }
    },
  );

  it("registers normally and permits isolated E2E runs to opt out", () => {
    expect(shouldRegisterMossAuthCallbackProtocolClient({})).toBe(true);
    expect(
      shouldRegisterMossAuthCallbackProtocolClient({
        MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: "1",
      }),
    ).toBe(false);
    expect(
      shouldRegisterMossAuthCallbackProtocolClient({
        MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: "0",
      }),
    ).toBe(true);
  });
});

describe("resolveMossAuthCallbackRoute", () => {
  it("maps the exact Moss auth callback to the renderer route", () => {
    expect(resolveMossAuthCallbackRoute("moss://auth/callback?code=pkce%2Bvalue")).toBe(
      "/auth/callback?code=pkce%2Bvalue",
    );
    expect(
      resolveMossAuthCallbackRoute(
        "moss://auth/callback?flow_id=flow_abcdefghijklmnopqrstuvwxyz-0123456789&code=google%2Bcode",
      ),
    ).toBe("/auth/callback?code=google%2Bcode&flowId=flow_abcdefghijklmnopqrstuvwxyz-0123456789");
  });

  it("bounds the single authorization code", () => {
    const maximumCode = "a".repeat(4096);
    expect(resolveMossAuthCallbackRoute(`moss://auth/callback?code=${maximumCode}`)).toBe(
      `/auth/callback?code=${maximumCode}`,
    );
    expect(
      resolveMossAuthCallbackRoute(`moss://auth/callback?code=${"a".repeat(4097)}`),
    ).toBeNull();
  });

  it("bounds and validates the Google OAuth flow id correlation query", () => {
    const maximumFlowId = "s".repeat(512);
    expect(
      resolveMossAuthCallbackRoute(`moss://auth/callback?flow_id=${maximumFlowId}&code=test`),
    ).toBe(`/auth/callback?code=test&flowId=${maximumFlowId}`);
    expect(
      resolveMossAuthCallbackRoute(`moss://auth/callback?flow_id=${"s".repeat(513)}&code=test`),
    ).toBeNull();
    expect(resolveMossAuthCallbackRoute("moss://auth/callback?flow_id=short&code=test")).toBeNull();
  });

  it.each([
    "https://auth/callback?code=test",
    "moss://app/auth/callback?code=test",
    "moss://auth/other?code=test",
    "moss://auth/callback/",
    "moss://auth:443/callback?code=test",
    "moss://auth:/callback?code=test",
    "moss://user@auth/callback?code=test",
    "moss://user:pass@auth/callback?code=test",
    "moss://@auth/callback?code=test",
    "moss://:@auth/callback?code=test",
    "moss://auth/callback?code=test#fragment",
    "moss://auth/callback#",
    "moss://auth/callback",
    "moss://auth/callback?code=",
    "moss://auth/callback?code=first&code=second",
    "moss://auth/callback?code=test&type=recovery",
    "moss://auth/callback/flow_abcdefghijklmnopqrstuvwxyz-0123456789?code=test",
    "moss://auth/callback?flow_id=flow_abcdefghijklmnopqrstuvwxyz-%2F0123456789&code=test",
    "moss://auth/callback?flow_id=flow_abcdefghijklmnopqrstuvwxyz-0123456789&code=test&state=unsafe",
    "moss://auth/callback?flow_id=first&flow_id=second&code=test",
    "moss://auth/callback?state=test&code=test",
    "moss://auth/callback?code=test&state=",
    "moss://auth/callback?code=test&state=%0A",
    "moss://auth/callback?code=test&state=first&state=second",
    "moss://auth/callback?code=test&next=%2Fsettings",
    "moss://auth/callback?type=verify",
    "moss://auth/callback?code=%0A",
    " moss://auth/callback?code=test",
    "moss://auth/callback?code=test\n",
    "not a URL",
  ])("rejects an untrusted callback URL: %s", (value) => {
    expect(resolveMossAuthCallbackRoute(value)).toBeNull();
  });
});

describe("resolveMossAuthCallbackRouteFromArgv", () => {
  it("finds a valid callback without interpreting flag-like arguments", () => {
    expect(
      resolveMossAuthCallbackRouteFromArgv([
        "/Applications/Moss.app/Contents/MacOS/Moss",
        "--url=moss://auth/callback?code=ignored",
        "moss://auth/callback?code=accepted",
      ]),
    ).toBe("/auth/callback?code=accepted");
  });

  it("returns null when argv has no exact callback", () => {
    expect(resolveMossAuthCallbackRouteFromArgv(["moss://app/index.html"])).toBeNull();
  });
});

describe("buildMossAuthCallbackRendererUrl", () => {
  it("targets hash history in development and packaged renderer URLs", () => {
    expect(
      buildMossAuthCallbackRendererUrl("http://localhost:5733/", "/auth/callback?code=test"),
    ).toBe("http://localhost:5733/#/auth/callback?code=test");
    expect(
      buildMossAuthCallbackRendererUrl("moss://app/index.html", "/auth/callback?code=test"),
    ).toBe("moss://app/index.html#/auth/callback?code=test");
    expect(
      buildMossAuthCallbackRendererUrl(
        "moss://app/index.html",
        "/auth/callback?code=test&flowId=flow_abcdefghijklmnopqrstuvwxyz-0123456789",
      ),
    ).toBe(
      "moss://app/index.html#/auth/callback?code=test&flowId=flow_abcdefghijklmnopqrstuvwxyz-0123456789",
    );
  });

  it("refuses to construct an arbitrary renderer route", () => {
    expect(() => buildMossAuthCallbackRendererUrl("moss://app/index.html", "/settings")).toThrow(
      "Invalid Moss authentication callback route.",
    );
    expect(() =>
      buildMossAuthCallbackRendererUrl(
        "moss://app/index.html",
        "/auth/callback?code=test&type=recovery",
      ),
    ).toThrow("Invalid Moss authentication callback route.");
    expect(() =>
      buildMossAuthCallbackRendererUrl(
        "moss://app/index.html",
        "/auth/callback?code=test#/settings",
      ),
    ).toThrow("Invalid Moss authentication callback route.");
  });
});
