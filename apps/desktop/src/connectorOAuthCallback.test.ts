import assert from "node:assert/strict";

import { describe, it, vi } from "vitest";

import {
  ConnectorOAuthCallbackInbox,
  installConnectorOAuthCallbackAppEvents,
  parseConnectorOAuthCallbackUrl,
  registerConnectorOAuthProtocolClient,
} from "./connectorOAuthCallback";

const fullRedirectUrl =
  "https://chatgpt.com/backend-api/aip/connectors/oauth/callback?account_id=acct%2Fwest&state=opaque%2B%2F%3D&code=one-time-code";

function callbackUrl(redirectUrl = fullRedirectUrl, returnTo = "/skills/manage?tab=apps"): string {
  const url = new URL("moss-connectors://connector/oauth_callback");
  url.searchParams.set("fullRedirectUrl", redirectUrl);
  url.searchParams.set("returnTo", returnTo);
  return url.href;
}

describe("parseConnectorOAuthCallbackUrl", () => {
  it("accepts the dedicated connector callback and preserves the opaque redirect bytes", () => {
    assert.deepStrictEqual(parseConnectorOAuthCallbackUrl(callbackUrl()), {
      fullRedirectUrl,
      returnTo: "/skills/manage?tab=apps",
    });
  });

  it("accepts an HTTPS redirect without returnTo", () => {
    const url = new URL("moss-connectors://connector/oauth_callback");
    url.searchParams.set("fullRedirectUrl", fullRedirectUrl);

    assert.deepStrictEqual(parseConnectorOAuthCallbackUrl(url.href), {
      fullRedirectUrl,
      returnTo: null,
    });
  });

  it("rejects wrong routes, credentials, fragments, duplicate values, and extra parameters", () => {
    const invalidUrls = [
      callbackUrl().replace("moss-connectors:", "moss:"),
      callbackUrl().replace("//connector/", "//other/"),
      callbackUrl().replace("/oauth_callback", "/oauth/callback"),
      callbackUrl().replace("//connector/", "//user@connector/"),
      `${callbackUrl()}#fragment`,
      `${callbackUrl()}&fullRedirectUrl=${encodeURIComponent(fullRedirectUrl)}`,
      `${callbackUrl()}&token=must-not-cross-native-ipc`,
    ];

    for (const url of invalidUrls) {
      assert.equal(parseConnectorOAuthCallbackUrl(url), null, url);
    }
  });

  it("rejects non-http redirect targets and unsafe return routes", () => {
    assert.equal(parseConnectorOAuthCallbackUrl(callbackUrl("file:///tmp/token", "/skills")), null);
    assert.equal(
      parseConnectorOAuthCallbackUrl(callbackUrl("javascript:alert(1)", "/skills")),
      null,
    );
    assert.equal(
      parseConnectorOAuthCallbackUrl(callbackUrl(fullRedirectUrl, "https://evil.test")),
      null,
    );
    assert.equal(parseConnectorOAuthCallbackUrl(callbackUrl(fullRedirectUrl, "//evil.test")), null);
    assert.equal(
      parseConnectorOAuthCallbackUrl(callbackUrl(fullRedirectUrl, "/\\evil.test")),
      null,
    );
  });
});

describe("ConnectorOAuthCallbackInbox", () => {
  it("queues cold-start argv and delivers once after the renderer subscribes", () => {
    const inbox = new ConnectorOAuthCallbackInbox();
    const received: Array<{ fullRedirectUrl: string; returnTo: string | null }> = [];

    assert.equal(
      inbox.enqueueArgv(["/Applications/Moss.app/Contents/MacOS/Moss", callbackUrl()]),
      1,
    );
    assert.equal(inbox.pendingCount, 1);
    assert.equal(
      inbox.drain((callback) => (received.push(callback), true)),
      1,
    );
    assert.equal(
      inbox.drain((callback) => (received.push(callback), true)),
      0,
    );
    assert.deepStrictEqual(received, [{ fullRedirectUrl, returnTo: "/skills/manage?tab=apps" }]);
    assert.equal(inbox.pendingCount, 0);
  });

  it("deduplicates a callback across open-url and second-instance argv", () => {
    const inbox = new ConnectorOAuthCallbackInbox();

    assert.equal(inbox.enqueueUrl(callbackUrl()), true);
    assert.equal(inbox.enqueueArgv([callbackUrl()]), 0);
    assert.equal(
      inbox.drain(() => true),
      1,
    );
    assert.equal(inbox.enqueueUrl(callbackUrl()), false);
    assert.equal(inbox.pendingCount, 0);
  });

  it("retains the callback when the subscriber cannot accept delivery", () => {
    const inbox = new ConnectorOAuthCallbackInbox();
    inbox.enqueueUrl(callbackUrl());

    assert.equal(
      inbox.drain(() => false),
      0,
    );
    assert.equal(inbox.pendingCount, 1);
    assert.equal(
      inbox.drain(() => true),
      1,
    );
    assert.equal(inbox.pendingCount, 0);
  });

  it("ignores unrelated or malformed process arguments", () => {
    const inbox = new ConnectorOAuthCallbackInbox();

    assert.equal(
      inbox.enqueueArgv([
        "/Applications/Moss.app/Contents/MacOS/Moss",
        "--flag",
        "https://example.com",
        "moss-connectors://connector/wrong",
      ]),
      0,
    );
    assert.equal(inbox.pendingCount, 0);
  });
});

class FakeCallbackApp {
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

describe("installConnectorOAuthCallbackAppEvents", () => {
  it("captures cold-start argv, macOS open-url, and running second-instance argv", () => {
    const app = new FakeCallbackApp();
    const inbox = new ConnectorOAuthCallbackInbox();
    let accepted = 0;
    const coldStartUrl = callbackUrl(fullRedirectUrl, "/skills");
    const runningUrl = callbackUrl(
      "https://chatgpt.com/callback?account_id=second&state=opaque-second&code=two",
      "/skills/manage",
    );
    const registration = installConnectorOAuthCallbackAppEvents({
      app,
      inbox,
      initialArgv: ["Moss", coldStartUrl],
      onCallbackAccepted: () => {
        accepted += 1;
      },
    });

    assert.equal(registration.initialAcceptedCount, 1);
    const openUrlEvent = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    app.emit("open-url", openUrlEvent, coldStartUrl);
    assert.equal(openUrlEvent.prevented, false, "duplicate callback is not re-consumed");

    app.emit("second-instance", {}, ["Moss", runningUrl], "/tmp", {});
    assert.equal(accepted, 1);
    assert.equal(inbox.pendingCount, 2);

    const thirdUrl = callbackUrl(
      "https://chatgpt.com/callback?account_id=third&state=opaque-third&code=three",
      "/skills",
    );
    app.emit("open-url", openUrlEvent, thirdUrl);
    assert.equal(openUrlEvent.prevented, true);
    assert.equal(accepted, 2);
    assert.equal(inbox.pendingCount, 3);

    registration.dispose();
    assert.equal(app.listeners.get("open-url")?.size, 0);
    assert.equal(app.listeners.get("second-instance")?.size, 0);
  });
});

describe("registerConnectorOAuthProtocolClient", () => {
  it.each([
    ["1", "skipped"],
    ["0", "registered"],
    [undefined, "registered"],
  ] as const)("honors the shared auth protocol opt-out (%s)", (setting, expected) => {
    vi.stubEnv("MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION", setting);
    try {
      const schemes: string[] = [];
      assert.equal(
        registerConnectorOAuthProtocolClient({
          isPackaged: true,
          setAsDefaultProtocolClient: (scheme) => (schemes.push(scheme), true),
        }),
        expected,
      );
      assert.deepStrictEqual(schemes, setting === "1" ? [] : ["moss-connectors"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("registers the dedicated callback scheme only for packaged builds", () => {
    const schemes: string[] = [];
    assert.equal(
      registerConnectorOAuthProtocolClient({
        isPackaged: true,
        setAsDefaultProtocolClient: (scheme) => (schemes.push(scheme), true),
      }),
      "registered",
    );
    assert.deepStrictEqual(schemes, ["moss-connectors"]);

    assert.equal(
      registerConnectorOAuthProtocolClient({
        isPackaged: false,
        setAsDefaultProtocolClient: (scheme) => (schemes.push(scheme), true),
      }),
      "skipped",
    );
    assert.deepStrictEqual(schemes, ["moss-connectors"]);
  });

  it("fails closed when OS registration is rejected or throws", () => {
    assert.equal(
      registerConnectorOAuthProtocolClient({
        isPackaged: true,
        setAsDefaultProtocolClient: () => false,
      }),
      "failed",
    );
    assert.equal(
      registerConnectorOAuthProtocolClient({
        isPackaged: true,
        setAsDefaultProtocolClient: () => {
          throw new Error("registration unavailable");
        },
      }),
      "failed",
    );
  });
});
