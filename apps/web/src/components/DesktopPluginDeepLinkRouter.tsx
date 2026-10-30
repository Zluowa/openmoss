// FILE: DesktopPluginDeepLinkRouter.tsx
// Purpose: Bridges trusted desktop plugin-route deliveries into app-owned TanStack history.
// Layer: Root route coordinator

import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeDesktopPluginDeepLinkNavigation } from "~/lib/desktopPluginDeepLinkNavigation";

export function DesktopPluginDeepLinkRouter() {
  const router = useRouter();

  useEffect(
    () =>
      subscribeDesktopPluginDeepLinkNavigation({
        bridge: window.desktopBridge?.pluginDeepLinks,
        navigate: async ({ pluginId, coldStart, source }) => {
          if (coldStart) {
            await router.navigate({
              to: "/skills",
              replace: true,
            });
          }
          await router.navigate({
            to: "/skills/plugins/$pluginId",
            params: { pluginId },
            state: (previous) => ({
              ...previous,
              desktopPluginDeepLink: { coldStart, source },
            }),
          });
        },
      }),
    [router],
  );

  return null;
}
