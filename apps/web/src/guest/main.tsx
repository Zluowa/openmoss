// FILE: main.tsx
// Purpose: Entry of the guest page bundle (`guest.html` → `dist-guest/index.html`).
// Layer: Guest page
// Why: The page mounts the app's own providers (store, settings-driven theme and typography,
//      localization, query client) around the guest flow, so the shared transcript components
//      render exactly as they do for the owner, with no router or app shell.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import { useAppDensity } from "~/hooks/useAppDensity";
import { useAppTypography } from "~/hooks/useAppTypography";
import { useChatWidth } from "~/hooks/useChatWidth";
import { useTheme } from "~/hooks/useTheme";
import { setAttachmentPreviewUrlResolver } from "~/lib/wsHttpUrl";
import { detachNativeApi } from "~/nativeApi";
import { MossLocalizationProvider } from "~/localization";
import { installZhCnUiLocalization } from "~/localization/zhCN";
import { StoreProvider } from "~/store";
import type { MossLocaleCode } from "~/uiLocale";

import { GuestApp } from "./components/GuestApp";
import { resolveGuestLocale } from "./guestStream.logic";
import { createHttpGuestTransport, type GuestTransport } from "./transport";
import { takeGuestEntry, type GuestEntry } from "./url";

// No Moss server stands behind this page; the relay serves only the guest routes.
detachNativeApi();

// The invite leaves the address bar before anything renders.
const entry = takeGuestEntry(window);
const locale = resolveGuestLocale(
  navigator.languages?.length ? navigator.languages : [navigator.language],
);

async function chooseTransport(): Promise<GuestTransport | null> {
  if (entry.shareId === null) return null;
  // Dev-only fixtures (`?mock=<scenario>`), left out of the production bundle.
  if (import.meta.env.DEV) {
    const scenario = new URLSearchParams(window.location.search).get("mock");
    if (scenario !== null) {
      const { createMockGuestTransport } = await import("./dev/mockTransport");
      return createMockGuestTransport(scenario, entry.shareId);
    }
  }
  return createHttpGuestTransport(entry.shareId);
}

// Pasting another guest link into this tab changes only the hash, which does not reload the
// page; reload so the new invite is read instead of the one already captured.
window.addEventListener("hashchange", () => {
  if (window.location.hash !== "") window.location.reload();
});

// No server behind this page: settings queries fail once and the local defaults apply.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

/** The root-level hooks the app route also runs: theme, type scale, density, chat width. */
function GuestRoot({
  entry,
  transport,
  locale,
}: {
  readonly entry: GuestEntry;
  readonly transport: GuestTransport | null;
  readonly locale: MossLocaleCode;
}) {
  useTheme();
  useAppTypography();
  useAppDensity();
  useChatWidth();
  return (
    <MossLocalizationProvider localeOverride={locale}>
      <GuestApp entry={entry} transport={transport} />
    </MossLocalizationProvider>
  );
}

void chooseTransport().then((transport) => {
  // Before the first snapshot: the shared timeline resolves attachment images through this.
  if (transport !== null) setAttachmentPreviewUrlResolver((id) => transport.attachmentUrl(id));
  installZhCnUiLocalization();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <StoreProvider>
          <GuestRoot entry={entry} transport={transport} locale={locale} />
        </StoreProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
