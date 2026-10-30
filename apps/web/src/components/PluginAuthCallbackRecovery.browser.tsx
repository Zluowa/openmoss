// FILE: PluginAuthCallbackRecovery.browser.tsx
// Purpose: Production callback-path regression for retrying failed plugin OAuth setup.

import "../index.css";

import type { DesktopConnectorOAuthCallback, ProviderAppInfo } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("../localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

import { AppConnectDialog, type AppConnectTarget } from "./AppConnectDialog";
import { usePluginAppConnectionFailureToast } from "./PluginLibrary";
import { PluginRequiredAppsDialog } from "./PluginRequiredAppsDialog";
import { toastManager } from "./ui/toast";
import { retainedPluginAuthSessionId, type PluginRequiredApp } from "./pluginAuthOnboarding";
import { usePluginAuthCallbackRecovery } from "./usePluginAuthCallbackRecovery";

const INITIAL_APPS: readonly PluginRequiredApp[] = [
  {
    id: "connector/github",
    name: "GitHub",
    description: "Work with repositories",
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: false,
    logoUrl: null,
    logoUrlDark: null,
    status: "pending",
  },
  {
    id: "connector/gmail",
    name: "Gmail",
    description: "Work with mail",
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: true,
    logoUrl: null,
    logoUrlDark: null,
    status: "connected",
  },
  {
    id: "connector/slack",
    name: "Slack",
    description: "Work with messages",
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: false,
    logoUrl: null,
    logoUrlDark: null,
    status: "opened",
  },
  {
    id: "connector/calendar",
    name: "Calendar",
    description: "Work with events",
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: false,
    logoUrl: null,
    logoUrlDark: null,
    status: "launching",
  },
];

function findAppButton(appId: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[data-plugin-required-app-id="${appId}"]`,
  );
}

function findGitHubButton(): HTMLButtonElement | null {
  return findAppButton("connector/github");
}

const ignoreAppConnectionFailure = (_appId: string) => undefined;
const ignoreFailure = (_cause: unknown) => undefined;

function CallbackAttemptHarness({
  bridge,
  completeAppConnection,
  onAppConnectionFailed = ignoreAppConnectionFailure,
  onFailure = ignoreFailure,
}: {
  readonly bridge: {
    onCallback: (listener: (callback: DesktopConnectorOAuthCallback) => void) => () => void;
  };
  readonly completeAppConnection: (fullRedirectUrl: string) => Promise<void>;
  readonly onAppConnectionFailed?: ((appId: string) => void) | undefined;
  readonly onFailure?: ((cause: unknown) => void) | undefined;
}) {
  const registerOpenedConnection = usePluginAuthCallbackRecovery({
    bridge,
    attemptScope: "codex:/workspace:session-a",
    completeAppConnection,
    reReadApps: async (): Promise<readonly ProviderAppInfo[]> => [],
    onAppsRead: () => undefined,
    onAppConnectionFailed,
    onFailure,
  });

  return (
    <>
      <button
        type="button"
        onClick={() =>
          registerOpenedConnection({
            appId: "connector/github",
            redirectUrl: "https://auth.example/start?state=github-state",
          })
        }
      >
        Register GitHub
      </button>
      <button
        type="button"
        onClick={() =>
          registerOpenedConnection({
            appId: "connector/slack",
            redirectUrl: "https://auth.example/start?state=slack-state",
          })
        }
      >
        Register Slack
      </button>
    </>
  );
}

function SingleOAuthAutoCloseHarness({
  bridge,
  completeAppConnection,
}: {
  readonly bridge: {
    onCallback: (listener: (callback: DesktopConnectorOAuthCallback) => void) => () => void;
  };
  readonly completeAppConnection: (fullRedirectUrl: string) => Promise<void>;
}) {
  const [setupSessionId, setSetupSessionId] = useState<number | null>(7);
  const [retainedSessionId, setRetainedSessionId] = useState<number | null>(null);
  const sessionId = setupSessionId ?? retainedSessionId;
  const registerOpenedConnection = usePluginAuthCallbackRecovery({
    bridge,
    attemptScope: sessionId === null ? null : `codex:/workspace:${sessionId}`,
    completeAppConnection,
    reReadApps: async (): Promise<readonly ProviderAppInfo[]> => [],
    onAppsRead: () => undefined,
    onAppConnectionFailed: ignoreAppConnectionFailure,
    onFailure: ignoreFailure,
  });

  return (
    <button
      type="button"
      onClick={() => {
        if (setupSessionId === null) return;
        const redirectUrl = "https://auth.example/start?state=single-state";
        setRetainedSessionId(
          retainedPluginAuthSessionId({
            mode: "single",
            sessionId: setupSessionId,
            redirectUrl,
          }),
        );
        registerOpenedConnection({ appId: "connector/github", redirectUrl });
        setSetupSessionId(null);
      }}
    >
      Open single OAuth
    </button>
  );
}

type CallbackListener = (callback: DesktopConnectorOAuthCallback) => void;

function createCallbackBridgeController() {
  let activeListener: CallbackListener | undefined;
  let retainedListener: CallbackListener | undefined;
  const cleanup = vi.fn(() => {
    activeListener = undefined;
  });
  const onCallback = vi.fn((listener: CallbackListener) => {
    activeListener = listener;
    retainedListener = listener;
    return cleanup;
  });
  return {
    bridge: { onCallback },
    cleanup,
    emit(callback: DesktopConnectorOAuthCallback) {
      activeListener?.(callback);
    },
    emitRetained(callback: DesktopConnectorOAuthCallback) {
      retainedListener?.(callback);
    },
  };
}

function CallbackLifecycleHarness({
  firstBridge,
  secondBridge,
  completeAppConnection,
  onAppConnectionFailed,
  onFailure,
}: {
  readonly firstBridge: ReturnType<typeof createCallbackBridgeController>["bridge"];
  readonly secondBridge: ReturnType<typeof createCallbackBridgeController>["bridge"];
  readonly completeAppConnection: (fullRedirectUrl: string) => Promise<void>;
  readonly onAppConnectionFailed: (appId: string) => void;
  readonly onFailure: (cause: unknown) => void;
}) {
  const [attemptScope, setAttemptScope] = useState<string | null>("codex:/workspace:session-a");
  const [bridge, setBridge] = useState(firstBridge);
  const [, setRenderCount] = useState(0);
  const registerOpenedConnection = usePluginAuthCallbackRecovery({
    bridge,
    attemptScope,
    completeAppConnection: (fullRedirectUrl) => completeAppConnection(fullRedirectUrl),
    reReadApps: async (): Promise<readonly ProviderAppInfo[]> => [],
    onAppsRead: () => undefined,
    onAppConnectionFailed: (appId) => onAppConnectionFailed(appId),
    onFailure: (cause) => onFailure(cause),
  });

  return (
    <>
      <button
        type="button"
        onClick={() =>
          registerOpenedConnection({
            appId: "connector/github",
            redirectUrl: "https://auth.example/start?state=session-a-state",
          })
        }
      >
        Register session A
      </button>
      <button type="button" onClick={() => setAttemptScope(null)}>
        Close onboarding
      </button>
      <button type="button" onClick={() => setAttemptScope("codex:/workspace:session-b")}>
        Start session B
      </button>
      <button
        type="button"
        onClick={() =>
          registerOpenedConnection({
            appId: "connector/slack",
            redirectUrl: "https://auth.example/start?state=session-b-state",
          })
        }
      >
        Register session B
      </button>
      <button type="button" onClick={() => setAttemptScope("claude:/workspace:session-b")}>
        Switch provider
      </button>
      <button
        type="button"
        onClick={() =>
          registerOpenedConnection({
            appId: "connector/notion",
            redirectUrl: "https://auth.example/start?state=provider-state",
          })
        }
      >
        Register current provider
      </button>
      <button type="button" onClick={() => setRenderCount((count) => count + 1)}>
        Rerender
      </button>
      <button type="button" onClick={() => setBridge(secondBridge)}>
        Replace bridge
      </button>
    </>
  );
}

function FailedOAuthHarness({
  bridge,
  onFailure,
}: {
  readonly bridge: {
    onCallback: (listener: (callback: DesktopConnectorOAuthCallback) => void) => () => void;
  };
  readonly onFailure: (cause: unknown) => void;
}) {
  const [apps, setApps] = useState(INITIAL_APPS);
  const [connectTarget, setConnectTarget] = useState<AppConnectTarget | null>(null);
  const registerOpenedConnection = usePluginAuthCallbackRecovery({
    bridge,
    attemptScope: "codex:/workspace:session-a",
    completeAppConnection: async () => {
      throw new Error("provider rejected callback");
    },
    reReadApps: async (): Promise<readonly ProviderAppInfo[]> => [],
    onAppsRead: () => undefined,
    onAppConnectionFailed: (appId) => {
      setApps((current) =>
        current.map((app) =>
          app.id === appId && app.status === "opened"
            ? Object.assign({}, app, { status: "pending" as const })
            : app,
        ),
      );
    },
    onFailure,
  });

  return (
    <>
      <PluginRequiredAppsDialog
        open={connectTarget === null}
        pluginName="GitHub"
        pluginLogoUrl={null}
        apps={apps}
        onOpenChange={() => undefined}
        onConnect={(app) => {
          setApps((current) =>
            current.map((candidate) =>
              candidate.id === app.id
                ? Object.assign({}, candidate, { status: "launching" as const })
                : candidate,
            ),
          );
          setConnectTarget(app);
        }}
        onViewDetails={() => undefined}
        onTryNow={() => undefined}
      />
      <AppConnectDialog
        app={connectTarget}
        open={connectTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConnectTarget(null);
        }}
        readConnector={async (app) => ({
          id: app.id,
          name: app.name,
          status: null,
          authMode: "OAUTH",
          requiresLinkParameters: false,
        })}
        readTerms={async () => ({
          blurbs: [],
          personalizationDefault: null,
          personalizationToggleBlurb: null,
        })}
        startConnection={async () => ({
          kind: "oauthStarted",
          redirectUrl: "https://auth.example/start?state=github-state",
        })}
        onOpenAppUrl={async () => true}
        onConnected={async () => undefined}
        onConnectionOpened={(connection) => {
          setApps((current) =>
            current.map((app) =>
              app.id === connection.appId
                ? Object.assign({}, app, { status: "opened" as const })
                : app,
            ),
          );
          registerOpenedConnection(connection);
        }}
      />
    </>
  );
}

function ProductionToastFailedOAuthHarness({
  bridge,
}: {
  readonly bridge: {
    onCallback: (listener: CallbackListener) => () => void;
  };
}) {
  const onFailure = usePluginAppConnectionFailureToast();
  return <FailedOAuthHarness bridge={bridge} onFailure={onFailure} />;
}

describe("plugin auth OAuth callback recovery", () => {
  beforeEach(() => {
    localizationTestState.locale = "en";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("restores exact Connect after opened OAuth callback completion fails", async () => {
    let callbackListener: ((callback: DesktopConnectorOAuthCallback) => void) | undefined;
    const onFailure = vi.fn();
    const screen = await render(
      <FailedOAuthHarness
        bridge={{
          onCallback: (listener) => {
            callbackListener = listener;
            return () => {
              callbackListener = undefined;
            };
          },
        }}
        onFailure={onFailure}
      />,
    );

    try {
      await expect.element(page.getByText("Connect your apps to GitHub")).toBeInTheDocument();
      expect(findGitHubButton()?.textContent?.trim()).toBe("Connect");
      expect(findGitHubButton()?.disabled).toBe(false);
      findGitHubButton()?.click();

      await expect
        .element(page.getByRole("heading", { name: "Connect GitHub" }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Continue to GitHub", exact: true }).click();

      await expect.element(page.getByText("Connect your apps to GitHub")).toBeInTheDocument();
      await vi.waitFor(() => expect(findGitHubButton()?.textContent?.trim()).toBe("Opened link"));
      expect(findGitHubButton()?.disabled).toBe(true);
      expect(findAppButton("connector/gmail")?.textContent?.trim()).toBe("Connected");
      expect(findAppButton("connector/slack")?.textContent?.trim()).toBe("Opened link");
      expect(findAppButton("connector/calendar")?.textContent?.trim()).toBe("Connect");
      expect(findAppButton("connector/calendar")?.disabled).toBe(true);

      callbackListener?.({
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=bad&state=github-state",
        returnTo: null,
      });

      await vi.waitFor(() => expect(findGitHubButton()?.textContent?.trim()).toBe("Connect"));
      expect(findGitHubButton()?.disabled).toBe(false);
      expect(findAppButton("connector/gmail")?.textContent?.trim()).toBe("Connected");
      expect(findAppButton("connector/slack")?.textContent?.trim()).toBe("Opened link");
      expect(findAppButton("connector/calendar")?.textContent?.trim()).toBe("Connect");
      expect(findAppButton("connector/calendar")?.disabled).toBe(true);
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "provider rejected callback",
        }),
      );

      findGitHubButton()?.click();
      await expect
        .element(page.getByRole("heading", { name: "Connect GitHub" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    { locale: "en" as const, title: "Failed to complete app connection" },
    { locale: "zh-CN" as const, title: "无法完成应用连接" },
  ])(
    "uses the exact $locale PluginLibrary toast for a production bridge callback",
    async ({ locale, title }) => {
      localizationTestState.locale = locale;
      let callbackListener: CallbackListener | undefined;
      const addToast = vi.spyOn(toastManager, "add");
      const screen = await render(
        <ProductionToastFailedOAuthHarness
          bridge={{
            onCallback: (listener) => {
              callbackListener = listener;
              return () => {
                callbackListener = undefined;
              };
            },
          }}
        />,
      );

      try {
        findGitHubButton()?.click();
        await expect
          .element(
            page.getByRole("heading", { name: locale === "en" ? "Connect GitHub" : "连接 GitHub" }),
          )
          .toBeInTheDocument();
        await page
          .getByRole("button", {
            name: locale === "en" ? "Continue to GitHub" : "继续 GitHub",
            exact: true,
          })
          .click();
        callbackListener?.({
          fullRedirectUrl:
            "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=bad&state=github-state",
          returnTo: null,
        });
        await vi.waitFor(() =>
          expect(addToast).toHaveBeenCalledWith({
            type: "error",
            title,
            description: "provider rejected callback",
          }),
        );
        const toastId = addToast.mock.results[0]?.value;
        if (toastId !== undefined) toastManager.close(toastId);
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each([
    {
      name: "an unknown state",
      fullRedirectUrl:
        "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=late&state=old-state",
    },
    {
      name: "no state while multiple attempts are active",
      fullRedirectUrl:
        "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=ambiguous",
    },
  ])("does not guess an app for $name", async ({ fullRedirectUrl }) => {
    let callbackListener: ((callback: DesktopConnectorOAuthCallback) => void) | undefined;
    const completeAppConnection = vi.fn(async () => undefined);
    const screen = await render(
      <CallbackAttemptHarness
        bridge={{
          onCallback: (listener) => {
            callbackListener = listener;
            return () => undefined;
          },
        }}
        completeAppConnection={completeAppConnection}
      />,
    );

    try {
      await page.getByRole("button", { name: "Register GitHub" }).click();
      await page.getByRole("button", { name: "Register Slack" }).click();
      callbackListener?.({ fullRedirectUrl, returnTo: null });
      expect(completeAppConnection).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("attributes a state-less callback only when one active attempt exists", async () => {
    let callbackListener: CallbackListener | undefined;
    const completeAppConnection = vi.fn(async () => undefined);
    const screen = await render(
      <CallbackAttemptHarness
        bridge={{
          onCallback: (listener) => {
            callbackListener = listener;
            return () => undefined;
          },
        }}
        completeAppConnection={completeAppConnection}
      />,
    );
    const fullRedirectUrl =
      "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=unique";

    try {
      await page.getByRole("button", { name: "Register GitHub" }).click();
      callbackListener?.({ fullRedirectUrl, returnTo: null });
      await vi.waitFor(() => expect(completeAppConnection).toHaveBeenCalledWith(fullRedirectUrl));
    } finally {
      await screen.unmount();
    }
  });

  it("completes a single-app OAuth callback after its dialog auto-closes", async () => {
    let callbackListener: CallbackListener | undefined;
    const onCallback = vi.fn((listener: CallbackListener) => {
      callbackListener = listener;
      return () => undefined;
    });
    const completeAppConnection = vi.fn(async () => undefined);
    const screen = await render(
      <SingleOAuthAutoCloseHarness
        bridge={{ onCallback }}
        completeAppConnection={completeAppConnection}
      />,
    );
    const fullRedirectUrl =
      "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=single&state=single-state";

    try {
      await page.getByRole("button", { name: "Open single OAuth" }).click();
      expect(onCallback).toHaveBeenCalledTimes(1);
      callbackListener?.({ fullRedirectUrl, returnTo: null });
      await vi.waitFor(() => expect(completeAppConnection).toHaveBeenCalledWith(fullRedirectUrl));
    } finally {
      await screen.unmount();
    }
  });

  it("correlates concurrent states and leaves the other attempt active", async () => {
    let callbackListener: CallbackListener | undefined;
    const completeAppConnection = vi.fn(async () => {
      throw new Error("provider rejected callback");
    });
    const onAppConnectionFailed = vi.fn();
    const screen = await render(
      <CallbackAttemptHarness
        bridge={{
          onCallback: (listener) => {
            callbackListener = listener;
            return () => undefined;
          },
        }}
        completeAppConnection={completeAppConnection}
        onAppConnectionFailed={onAppConnectionFailed}
      />,
    );

    try {
      await page.getByRole("button", { name: "Register GitHub" }).click();
      await page.getByRole("button", { name: "Register Slack" }).click();
      callbackListener?.({
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=slack&state=slack-state",
        returnTo: null,
      });
      await vi.waitFor(() =>
        expect(onAppConnectionFailed).toHaveBeenNthCalledWith(1, "connector/slack"),
      );

      callbackListener?.({
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=github",
        returnTo: null,
      });
      await vi.waitFor(() =>
        expect(onAppConnectionFailed).toHaveBeenNthCalledWith(2, "connector/github"),
      );
      expect(completeAppConnection).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("clears attempts across close, session, and provider scopes and cleans bridge ownership once", async () => {
    const first = createCallbackBridgeController();
    const second = createCallbackBridgeController();
    const completeAppConnection = vi.fn(async () => {
      throw new Error("provider rejected callback");
    });
    const onAppConnectionFailed = vi.fn();
    const onFailure = vi.fn();
    const screen = await render(
      <CallbackLifecycleHarness
        firstBridge={first.bridge}
        secondBridge={second.bridge}
        completeAppConnection={completeAppConnection}
        onAppConnectionFailed={onAppConnectionFailed}
        onFailure={onFailure}
      />,
    );

    try {
      await vi.waitFor(() => expect(first.bridge.onCallback).toHaveBeenCalledTimes(1));
      await page.getByRole("button", { name: "Register session A" }).click();
      await page.getByRole("button", { name: "Close onboarding" }).click();
      first.emit({
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=late-a&state=session-a-state",
        returnTo: null,
      });
      expect(completeAppConnection).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Start session B" }).click();
      await page.getByRole("button", { name: "Register session B" }).click();
      await page.getByRole("button", { name: "Switch provider" }).click();
      first.emit({
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=late-b&state=session-b-state",
        returnTo: null,
      });
      expect(completeAppConnection).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Register current provider" }).click();
      await page.getByRole("button", { name: "Rerender" }).click();
      expect(first.bridge.onCallback).toHaveBeenCalledTimes(1);
      expect(first.cleanup).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Replace bridge" }).click();
      await vi.waitFor(() => expect(first.cleanup).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(second.bridge.onCallback).toHaveBeenCalledTimes(1));

      const callback = {
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=current&state=provider-state",
        returnTo: null,
      } satisfies DesktopConnectorOAuthCallback;
      first.emitRetained(callback);
      expect(completeAppConnection).not.toHaveBeenCalled();
      second.emit(callback);
      second.emit(callback);
      await vi.waitFor(() => expect(completeAppConnection).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(onAppConnectionFailed).toHaveBeenCalledWith("connector/notion"),
      );
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }

    expect(first.cleanup).toHaveBeenCalledTimes(1);
    expect(second.cleanup).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight failure after a new onboarding session starts", async () => {
    const bridge = createCallbackBridgeController();
    let rejectCompletion: ((cause: Error) => void) | undefined;
    const completeAppConnection = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCompletion = reject;
        }),
    );
    const onAppConnectionFailed = vi.fn();
    const onFailure = vi.fn();
    const screen = await render(
      <CallbackLifecycleHarness
        firstBridge={bridge.bridge}
        secondBridge={bridge.bridge}
        completeAppConnection={completeAppConnection}
        onAppConnectionFailed={onAppConnectionFailed}
        onFailure={onFailure}
      />,
    );

    try {
      await page.getByRole("button", { name: "Register session A" }).click();
      bridge.emit({
        fullRedirectUrl:
          "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=slow&state=session-a-state",
        returnTo: null,
      });
      await vi.waitFor(() => expect(completeAppConnection).toHaveBeenCalledTimes(1));
      await page.getByRole("button", { name: "Start session B" }).click();
      rejectCompletion?.(new Error("late provider rejection"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onAppConnectionFailed).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("drops an in-flight failure after unmount and cleans the bridge once", async () => {
    const bridge = createCallbackBridgeController();
    let rejectCompletion: ((cause: Error) => void) | undefined;
    const completeAppConnection = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCompletion = reject;
        }),
    );
    const onAppConnectionFailed = vi.fn();
    const onFailure = vi.fn();
    const screen = await render(
      <CallbackLifecycleHarness
        firstBridge={bridge.bridge}
        secondBridge={bridge.bridge}
        completeAppConnection={completeAppConnection}
        onAppConnectionFailed={onAppConnectionFailed}
        onFailure={onFailure}
      />,
    );

    await page.getByRole("button", { name: "Register session A" }).click();
    bridge.emit({
      fullRedirectUrl:
        "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=slow-unmount&state=session-a-state",
      returnTo: null,
    });
    await vi.waitFor(() => expect(completeAppConnection).toHaveBeenCalledTimes(1));
    await screen.unmount();
    rejectCompletion?.(new Error("late unmounted rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAppConnectionFailed).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(bridge.cleanup).toHaveBeenCalledTimes(1);
  });
});
