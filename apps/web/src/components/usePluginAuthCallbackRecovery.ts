// FILE: usePluginAuthCallbackRecovery.ts
// Purpose: Correlates OAuth callbacks with plugin onboarding rows and recovers retry state.

import type { DesktopConnectorOAuthCallback, ProviderAppInfo } from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { createConnectorOAuthCallbackSubscription } from "~/lib/appToolsModel";
import type { AppConnectionOpened } from "./AppConnectDialog";

interface ConnectorOAuthBridge {
  onCallback: (listener: (callback: DesktopConnectorOAuthCallback) => void) => () => void;
}

interface ActivePluginAuthAttempt {
  readonly appId: string;
  readonly oauthState: string | null;
  readonly scope: string;
}

const MAX_CONSUMED_CALLBACKS = 256;

function oauthStateFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const queryState = url.searchParams.get("state")?.trim();
    if (queryState) return queryState;
    const queryIndex = url.hash.indexOf("?");
    if (queryIndex < 0) return null;
    return new URLSearchParams(url.hash.slice(queryIndex + 1)).get("state")?.trim() || null;
  } catch {
    return null;
  }
}

export function usePluginAuthCallbackRecovery(input: {
  readonly bridge: ConnectorOAuthBridge | undefined;
  readonly attemptScope: string | null;
  readonly completeAppConnection: (fullRedirectUrl: string) => Promise<void>;
  readonly reReadApps: () => Promise<readonly ProviderAppInfo[]>;
  readonly onAppsRead: (apps: readonly ProviderAppInfo[]) => void;
  readonly onAppConnectionFailed: (appId: string) => void;
  readonly onFailure: (cause: unknown) => void;
}): (connection: AppConnectionOpened) => void {
  const {
    bridge,
    attemptScope,
    completeAppConnection,
    reReadApps,
    onAppsRead,
    onAppConnectionFailed,
    onFailure,
  } = input;
  const activeScopeRef = useRef<string | null>(null);
  const activeAttemptsRef = useRef<ActivePluginAuthAttempt[]>([]);
  const consumedCallbacksRef = useRef(new Set<string>());
  const handlersRef = useRef({
    completeAppConnection,
    reReadApps,
    onAppsRead,
    onAppConnectionFailed,
    onFailure,
  });

  useLayoutEffect(() => {
    handlersRef.current = {
      completeAppConnection,
      reReadApps,
      onAppsRead,
      onAppConnectionFailed,
      onFailure,
    };
  });

  useLayoutEffect(() => {
    activeScopeRef.current = attemptScope;
    activeAttemptsRef.current = [];
  }, [attemptScope]);

  useEffect(
    () => () => {
      activeScopeRef.current = null;
      activeAttemptsRef.current = [];
    },
    [],
  );

  const registerOpenedConnection = useCallback(
    (connection: AppConnectionOpened) => {
      if (!attemptScope || activeScopeRef.current !== attemptScope || !connection.redirectUrl) {
        return;
      }
      activeAttemptsRef.current = [
        ...activeAttemptsRef.current.filter(
          (attempt) => attempt.scope === attemptScope && attempt.appId !== connection.appId,
        ),
        {
          appId: connection.appId,
          oauthState: oauthStateFromUrl(connection.redirectUrl),
          scope: attemptScope,
        },
      ];
    },
    [attemptScope],
  );

  useEffect(() => {
    let ownsBridgeSubscription = true;
    const unsubscribe = createConnectorOAuthCallbackSubscription(bridge, async (callback) => {
      if (!ownsBridgeSubscription || consumedCallbacksRef.current.has(callback.fullRedirectUrl)) {
        return;
      }
      consumedCallbacksRef.current.add(callback.fullRedirectUrl);
      if (consumedCallbacksRef.current.size > MAX_CONSUMED_CALLBACKS) {
        const oldest = consumedCallbacksRef.current.values().next().value;
        if (oldest !== undefined) consumedCallbacksRef.current.delete(oldest);
      }

      const scope = activeScopeRef.current;
      if (!scope) return;
      const attempts = activeAttemptsRef.current.filter((attempt) => attempt.scope === scope);
      const callbackState = oauthStateFromUrl(callback.fullRedirectUrl);
      const matches = callbackState
        ? attempts.filter((attempt) => attempt.oauthState === callbackState)
        : attempts;
      if (matches.length !== 1) return;
      const attempt = matches[0]!;
      activeAttemptsRef.current = activeAttemptsRef.current.filter(
        (candidate) => candidate !== attempt,
      );

      try {
        await handlersRef.current.completeAppConnection(callback.fullRedirectUrl);
        if (activeScopeRef.current !== attempt.scope) return;
        const apps = await handlersRef.current.reReadApps();
        if (activeScopeRef.current === attempt.scope) handlersRef.current.onAppsRead(apps);
      } catch (cause: unknown) {
        if (activeScopeRef.current !== attempt.scope) return;
        handlersRef.current.onAppConnectionFailed(attempt.appId);
        handlersRef.current.onFailure(cause);
        throw cause;
      }
    });
    return () => {
      ownsBridgeSubscription = false;
      unsubscribe();
    };
  }, [bridge]);

  return registerOpenedConnection;
}
