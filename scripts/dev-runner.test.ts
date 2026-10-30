import * as NodeServices from "@effect/platform-node/NodeServices";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createDevRunnerEnv,
  findFirstAvailableOffset,
  readDevProductionPublicConfig,
  readDevRunnerBooleanEnvironment,
  resolveDevRunnerBooleanOverrides,
  resolveModePortOffsets,
  resolveOffset,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  it("allows every generated runtime setting through Turbo", () => {
    const turboConfig = JSON.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf8"),
    ) as { globalEnv?: ReadonlyArray<string> };
    const globalEnv = new Set(turboConfig.globalEnv ?? []);

    for (const name of [
      "MOSS_MODE",
      "MOSS_PORT",
      "MOSS_HOME",
      "MOSS_NO_BROWSER",
      "MOSS_AUTH_TOKEN",
      "MOSS_PUBLIC_URL",
      "MOSS_ALLOW_INSECURE_REMOTE",
      "MOSS_HOST",
      "MOSS_LOG_WS_EVENTS",
      "MOSS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
      "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
      "VITE_WS_URL",
      "VITE_DEV_SERVER_URL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ]) {
      assert.ok(globalEnv.has(name), `${name} must be declared in turbo.json globalEnv`);
    }

    const turboWithPassThrough = JSON.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf8"),
    ) as { globalPassThroughEnv?: ReadonlyArray<string> };
    const passThrough = new Set(turboWithPassThrough.globalPassThroughEnv ?? []);
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ]) {
      assert.ok(
        passThrough.has(name),
        `${name} must be declared in turbo.json globalPassThroughEnv`,
      );
    }
  });

  describe("resolveOffset", () => {
    it.effect("uses explicit MOSS_PORT_OFFSET when provided", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "MOSS_PORT_OFFSET=12",
        });
      }),
    );

    it("hashes non-numeric instance values", () => {
      const result = resolveOffset({ portOffset: undefined, devInstance: "feature-branch" });
      assert.ok(result.offset >= 1);
      assert.ok(result.offset <= 3000);
    });

    it.effect("throws for negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.try({
            try: () => resolveOffset({ portOffset: -1, devInstance: undefined }),
            catch: (cause) => String(cause),
          }),
        );

        assert.ok(error.includes("Invalid MOSS_PORT_OFFSET"));
      }),
    );
  });

  describe("boolean precedence", () => {
    const absent = { positive: undefined, negative: undefined };

    it("uses environment values only when the CLI flag is absent", () => {
      assert.deepStrictEqual(
        resolveDevRunnerBooleanOverrides(
          {
            noBrowser: absent,
            autoBootstrapProjectFromCwd: absent,
            logWebSocketEvents: absent,
            productionConfig: absent,
          },
          {
            noBrowser: true,
            autoBootstrapProjectFromCwd: false,
            logWebSocketEvents: true,
            productionConfig: true,
          },
        ),
        {
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          productionConfig: true,
        },
      );
    });

    it("keeps explicit false values instead of treating them as absent", () => {
      assert.deepStrictEqual(
        resolveDevRunnerBooleanOverrides(
          {
            noBrowser: { positive: undefined, negative: true },
            autoBootstrapProjectFromCwd: { positive: false, negative: undefined },
            logWebSocketEvents: { positive: undefined, negative: true },
            productionConfig: { positive: false, negative: undefined },
          },
          {
            noBrowser: true,
            autoBootstrapProjectFromCwd: true,
            logWebSocketEvents: true,
            productionConfig: true,
          },
        ),
        {
          noBrowser: false,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          productionConfig: false,
        },
      );
    });

    it.effect("rejects invalid boolean environment values", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readDevRunnerBooleanEnvironment({ MOSS_LOG_WS_EVENTS: "sometimes" }),
        );

        assert.match(String(error), /Failed to read boolean development-runner configuration/);
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    const defaults: Parameters<typeof createDevRunnerEnv>[0] = {
      mode: "dev",
      baseEnv: {},
      serverOffset: 0,
      webOffset: 0,
      mossHome: undefined,
      authToken: undefined,
      noBrowser: undefined,
      autoBootstrapProjectFromCwd: undefined,
      logWebSocketEvents: undefined,
      host: undefined,
      port: undefined,
      devUrl: undefined,
    };

    it.effect("marks an inherited terminal PATH as already hydrated", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          baseEnv: { PATH: "/opt/homebrew/bin:/usr/bin" },
        });

        assert.equal(env.MOSS_PATH_HYDRATED, "1");
        assert.match(env.PATH ?? "", /\/opt\/homebrew\/bin/);
      }),
    );

    it.effect("leaves Moss sign-in unconfigured unless the release config is opted into", () =>
      Effect.gen(function* () {
        const inherited = {
          MOSS_SUPABASE_URL: "https://legacy.example.com",
          MOSS_MEMFIRE_PHONE_URL: "https://shell.example.com",
        };
        const plain = yield* createDevRunnerEnv({ ...defaults, baseEnv: inherited });
        assert.equal(plain.MOSS_MEMFIRE_PHONE_URL, "https://shell.example.com");

        const config = yield* readDevProductionPublicConfig();
        const env = yield* createDevRunnerEnv({
          ...defaults,
          baseEnv: inherited,
          productionPublicConfig: config,
        });
        // The release manifest wins over whatever the shell carried, legacy aliases included.
        assert.equal(env.MOSS_MEMFIRE_PHONE_URL, config.authRealms["memfire-phone"].authUrl);
        assert.equal(
          env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL,
          config.authRealms["memfire-phone"].modelGatewayUrl,
        );
        assert.equal(env.MOSS_SUPABASE_URL, undefined);
        assert.equal(env.MOSS_PRODUCTION_CONFIG_VERSION, "2");
      }),
    );

    it.effect("defaults MOSS_HOME to ~/.moss when not provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
        });

        assert.equal(env.MOSS_HOME, resolve(homedir(), ".moss"));
        assert.equal(env.MOSS_HOST, "127.0.0.1");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:3773");
      }),
    );

    it.effect("defaults watched desktop development to ~/.moss-dev", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          mode: "dev:desktop",
        });

        assert.equal(env.MOSS_HOME, resolve(homedir(), ".moss"));
      }),
    );

    it.effect("keeps watched Canary desktop data separate from development", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          mode: "dev:desktop",
          baseEnv: { MOSS_DESKTOP_FLAVOR: "canary" },
        });

        assert.equal(env.MOSS_HOME, resolve(homedir(), ".moss-canary"));
      }),
    );

    it.effect("normalizes bracketed IPv6 hosts for listen and client URL syntax", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          host: "[::1]",
        });

        assert.equal(env.MOSS_HOST, "::1");
        assert.equal(env.VITE_WS_URL, "ws://[::1]:3773");
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          mode: "dev:server",
          mossHome: "/tmp/custom-moss",
          authToken: "secret",
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.MOSS_HOME, resolve("/tmp/custom-moss"));
        assert.equal(env.MOSS_PORT, "4222");
        assert.equal(env.MOSS_NO_BROWSER, "1");
        assert.equal(env.MOSS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.MOSS_LOG_WS_EVENTS, "1");
        assert.equal(env.MOSS_HOST, "0.0.0.0");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:4222");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          baseEnv: {
            MOSS_LOG_WS_EVENTS: "keep-me-out",
          },
        });

        assert.equal(env.MOSS_MODE, "web");
        assert.equal(env.MOSS_LOG_WS_EVENTS, undefined);
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([3773, 5733, 3774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("allows offsets where only non-required ports exceed max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_803,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_803);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([3773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("rejects implicit web port drift that would fail WebSocket origin validation", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const error = yield* Effect.flip(
          resolveModePortOffsets({
            mode: "dev:web",
            startOffset: 0,
            hasExplicitServerPort: false,
            hasExplicitDevUrl: false,
            checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
          }),
        );

        assert.match(String(error), /MOSS_DEV_WEB_PORT_MISMATCH/);
        assert.match(String(error), /5734/);
        assert.match(String(error), /--dev-url/);
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([3773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });
});
