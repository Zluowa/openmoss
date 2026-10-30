// FILE: mossAppsReactQuery.ts
// Purpose: The react-query definitions for Moss Apps — status, the whole app
//   catalog, and the user's connections — read by the plugin directory, where
//   apps are plugins, so a connect or disconnect refreshes every surface.
// Layer: Web data access
// Exports: MOSS_APPS_QUERY_KEY, mossAppsStatusQueryOptions,
//   mossAppCatalogQueryOptions, mossAppConnectionsQueryOptions,
//   mossAppConnectFieldsQueryOptions

import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const MOSS_APPS_QUERY_KEY = ["mossApps"] as const;
export const MOSS_APP_CONNECTIONS_QUERY_KEY = [...MOSS_APPS_QUERY_KEY, "connections"] as const;

/** While a hosted sign-in is open, connections are polled at this interval. */
export const MOSS_APP_SIGN_IN_POLL_MS = 2_500;

export function mossAppsStatusQueryOptions() {
  return queryOptions({
    queryKey: [...MOSS_APPS_QUERY_KEY, "status"] as const,
    queryFn: () => ensureNativeApi().server.getMossAppsStatus(),
    staleTime: 30_000,
    // Remote clients get a definitive loopback-only refusal; retrying repeats it.
    retry: false,
  });
}

/** The whole catalog once (the server walks and caches it hourly). */
export function mossAppCatalogQueryOptions(input: { readonly enabled: boolean }) {
  return queryOptions({
    queryKey: [...MOSS_APPS_QUERY_KEY, "catalog"] as const,
    queryFn: () => ensureNativeApi().server.listMossAppToolkits({ all: true }),
    enabled: input.enabled,
    staleTime: 60 * 60_000,
    // One slow or dropped read (a busy server, a reconnect) must not leave the
    // directory without its Moss Apps section; the server shares one catalog walk.
    retry: 2,
  });
}

/** What a user enters to connect an app with their own key or login. */
export function mossAppConnectFieldsQueryOptions(input: {
  readonly toolkitSlug: string | null;
  readonly enabled: boolean;
}) {
  return queryOptions({
    queryKey: [...MOSS_APPS_QUERY_KEY, "connect-fields", input.toolkitSlug] as const,
    queryFn: () =>
      ensureNativeApi().server.getMossAppConnectFields({ toolkitSlug: input.toolkitSlug ?? "" }),
    enabled: input.enabled && input.toolkitSlug !== null,
    staleTime: 60 * 60_000,
    retry: false,
  });
}

export function mossAppConnectionsQueryOptions(input: {
  readonly enabled: boolean;
  readonly polling: boolean;
}) {
  return queryOptions({
    queryKey: MOSS_APP_CONNECTIONS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listMossAppConnections(),
    enabled: input.enabled,
    staleTime: 10_000,
    refetchInterval: input.polling ? MOSS_APP_SIGN_IN_POLL_MS : false,
    retry: false,
  });
}
